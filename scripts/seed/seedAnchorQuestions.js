require('dotenv').config();
const mongoose = require('mongoose');
const openai = require('../../src/config/openai');
const TopicTaxonomy = require('../../src/models/TopicTaxonomy');
const QuestionBank = require('../../src/models/DiagnosticQuestionBank');
const budget = require('../../src/services/diagnostic/llmCallBudget');
const { withRetry } = require('../../src/services/diagnostic/withRetry');

const ANCHOR_SCHEMA = {
  name: 'anchor_questions',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 2,
        maxItems: 3,
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

const SYSTEM_PROMPT = `You write gold-standard diagnostic anchor questions for an Indian learning platform. These are the reference examples that downstream LLM-generation will mimic — quality matters.

Rules:
- Real-world scenarios, not textbook definitions
- Use Indian company examples where natural (Razorpay, Flipkart, Zomato, Sarvam, etc.)
- Salary references in INR
- Single unambiguously correct answer
- Other options should be plausible-but-wrong, not obviously absurd
- Match the stated difficulty
- No double negatives, no leading wording`;

async function generateAnchorsForTopic(topic, targetKey, opts = {}) {
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
Difficulty: ${topic.baseDifficulty}

Generate 2-3 anchor questions. They will serve as few-shot examples for generating ~12 more questions on this topic.`,
            },
          ],
          response_format: { type: 'json_schema', json_schema: ANCHOR_SCHEMA },
          temperature: 0.6,
          max_tokens: 2000,
        },
        { signal: controller.signal }
      )
    );

    const parsed = JSON.parse(completion.choices[0].message.content);
    return parsed.questions.map(q => ({
      ...q,
      canonicalCompetency: topic.canonicalName,
      difficulty: mapDifficulty(topic.baseDifficulty),
      isAnchor: true,
      generationSource: 'seed_batch',
      verificationStatus: 'pending',
    }));
  } finally {
    clearTimeout(timer);
  }
}

function mapDifficulty(baseDifficulty) {
  return { foundational: 'easy', intermediate: 'medium', advanced: 'hard' }[baseDifficulty] || 'medium';
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const taxonomies = await TopicTaxonomy.find({}).lean();
  console.log(`Generating anchors for ${taxonomies.length} taxonomies...`);
  let totalAnchors = 0;
  let failures = 0;
  for (const tax of taxonomies) {
    for (const topic of tax.topics) {
      try {
        const exists = await QuestionBank.exists({
          canonicalCompetency: topic.canonicalName,
          isAnchor: true,
        });
        if (exists) {
          console.log(`  - ${tax.targetKey} :: ${topic.name} skip (anchors exist)`);
          continue;
        }
        const anchors = await generateAnchorsForTopic(topic, tax.targetKey);
        await QuestionBank.insertMany(anchors);
        totalAnchors += anchors.length;
        console.log(`  ✓ ${tax.targetKey} :: ${topic.name} (+${anchors.length})`);
      } catch (e) {
        failures++;
        console.error(`  ✗ ${tax.targetKey} :: ${topic.name}: ${e.message}`);
      }
    }
  }
  console.log(`Done. Anchors: ${totalAnchors}, Failures: ${failures}`);
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { generateAnchorsForTopic };
