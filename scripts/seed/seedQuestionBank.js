require('dotenv').config();
const mongoose = require('mongoose');
const openai = require('../../src/config/openai');
const TopicTaxonomy = require('../../src/models/TopicTaxonomy');
const QuestionBank = require('../../src/models/DiagnosticQuestionBank');
const { validateQuestion } = require('../../src/services/diagnostic/questionValidatorService');
const budget = require('../../src/services/diagnostic/llmCallBudget');
const { withRetry } = require('../../src/services/diagnostic/withRetry');

const BATCH_SCHEMA = {
  name: 'question_batch',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            questionText: { type: 'string' },
            options: {
              type: 'array',
              minItems: 4,
              maxItems: 4,
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', enum: ['A', 'B', 'C', 'D'] },
                  text: { type: 'string' },
                },
                required: ['label', 'text'],
                additionalProperties: false,
              },
            },
            correctAnswer: { type: 'string', enum: ['A', 'B', 'C', 'D'] },
            rationale: { type: 'string' },
          },
          required: ['questionText', 'options', 'correctAnswer', 'rationale'],
          additionalProperties: false,
        },
      },
    },
    required: ['questions'],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = `You generate diagnostic questions for an Indian learning platform.
Rules:
- Real-world scenarios, not textbook definitions
- Indian company examples where natural (Razorpay, Flipkart, Zomato, etc.)
- INR salary references where relevant
- Single unambiguously correct answer
- Plausible-but-wrong distractors
- Match the stated difficulty exactly
- No double negatives, no leading wording`;

function buildAnchorsBlock(anchors) {
  return anchors
    .slice(0, 3)
    .map((a, i) => {
      const opts = a.options.map(o => `${o.label}. ${o.text}`).join('\n');
      return `Anchor ${i + 1}:\n${a.questionText}\n${opts}\nCorrect: ${a.correctAnswer}`;
    })
    .join('\n\n');
}

async function generateBatch(topic, targetKey, difficulty, anchors, count = 4, opts = {}) {
  const timeoutMs = opts.timeoutMs || 30000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    budget.increment();
    const completion = await withRetry(() =>
      openai.chat.completions.create(
        {
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: `Topic: ${topic.name} (${topic.canonicalName})
Topic context: ${topic.description}
Target user context: ${targetKey}
Difficulty: ${difficulty}
Generate exactly ${count} questions in the same style and rigour as these anchors:

${buildAnchorsBlock(anchors)}`,
            },
          ],
          response_format: { type: 'json_schema', json_schema: BATCH_SCHEMA },
          temperature: 0.7,
          max_tokens: 2500,
        },
        { signal: controller.signal }
      )
    );
    const parsed = JSON.parse(completion.choices[0].message.content);
    const validated = [];
    for (const q of parsed.questions) {
      const enriched = {
        ...q,
        canonicalCompetency: topic.canonicalName,
        difficulty,
        isAnchor: false,
        generationSource: 'seed_batch',
      };
      const v = await validateQuestion(enriched);
      validated.push({
        ...enriched,
        verificationStatus: v.status,
        validatorScore: v.score,
        validatorCritique: v.critique,
      });
    }
    return validated;
  } finally {
    clearTimeout(timer);
  }
}

async function runBatchesInParallel(jobs, concurrency = 6) {
  const results = [];
  for (let i = 0; i < jobs.length; i += concurrency) {
    const slice = jobs.slice(i, i + concurrency);
    const settled = await Promise.allSettled(slice.map(j => j()));
    results.push(...settled);
  }
  return results;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const taxonomies = await TopicTaxonomy.find({}).lean();
  const difficulties = ['easy', 'medium', 'hard'];

  const jobs = [];
  for (const tax of taxonomies) {
    for (const topic of tax.topics) {
      const anchors = await QuestionBank.find({
        canonicalCompetency: topic.canonicalName,
        isAnchor: true,
      }).lean();
      if (anchors.length === 0) {
        console.warn(`No anchors found for ${topic.canonicalName} — skipping`);
        continue;
      }
      for (const diff of difficulties) {
        const existing = await QuestionBank.countDocuments({
          canonicalCompetency: topic.canonicalName,
          difficulty: diff,
          isAnchor: false,
        });
        if (existing >= 4) {
          console.log(`  - skip ${tax.targetKey} :: ${topic.canonicalName} [${diff}] (already has ${existing} questions)`);
          continue;
        }
        jobs.push(async () => {
          const questions = await generateBatch(topic, tax.targetKey, diff, anchors, 4);
          await QuestionBank.insertMany(questions);
          return { targetKey: tax.targetKey, topic: topic.canonicalName, diff, count: questions.length };
        });
      }
    }
  }

  console.log(`Running ${jobs.length} generation jobs (concurrency=6)...`);
  const results = await runBatchesInParallel(jobs, 6);
  const ok = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;
  console.log(`Done. OK: ${ok}, Failed: ${failed}`);
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { generateBatch, runBatchesInParallel };
