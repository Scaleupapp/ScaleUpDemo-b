const openai = require('../../config/openai');
const QuestionBank = require('../../models/DiagnosticQuestionBank');
const { validateQuestion } = require('./questionValidatorService');

const BATCH_SCHEMA = {
  name: 'realtime_question_batch',
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
- Match the stated difficulty exactly`;

function buildAnchorsBlock(anchors) {
  return anchors
    .slice(0, 3)
    .map((a, i) => {
      const opts = a.options.map(o => `${o.label}. ${o.text}`).join('\n');
      return `Anchor ${i + 1}:\n${a.questionText}\n${opts}\nCorrect: ${a.correctAnswer}`;
    })
    .join('\n\n');
}

async function fetchAnchors(canonicalCompetency) {
  return QuestionBank.find({
    canonicalCompetency,
    isAnchor: true,
  }).lean();
}

async function generateOnDemand({ topic, targetKey, difficulty, count = 4, opts = {} }) {
  const timeoutMs = opts.timeoutMs || 12000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const anchors = await fetchAnchors(topic.canonicalName);
    const anchorsBlock = anchors.length > 0
      ? `Generate exactly ${count} questions in the same style and rigour as these anchors:\n\n${buildAnchorsBlock(anchors)}`
      : `Generate exactly ${count} questions.`;

    const completion = await openai.chat.completions.create(
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
${anchorsBlock}`,
          },
        ],
        response_format: { type: 'json_schema', json_schema: BATCH_SCHEMA },
        temperature: 0.7,
        max_tokens: 2500,
      },
      { signal: controller.signal }
    );

    const parsed = JSON.parse(completion.choices[0].message.content);
    const validated = [];
    for (const q of parsed.questions) {
      const enriched = {
        ...q,
        canonicalCompetency: topic.canonicalName,
        difficulty,
        isAnchor: false,
        generationSource: 'llm_realtime',
      };
      const v = await validateQuestion(enriched);
      validated.push({
        ...enriched,
        verificationStatus: v.status,
        validatorScore: v.score,
        validatorCritique: v.critique,
      });
    }

    if (validated.length === 0) return [];
    // insertMany returns mongoose documents whose _id is populated; the
    // input `validated` array is *not* mutated, so we must return the
    // result. If we return the input array, downstream code (the pool
    // assembler) sees questions with no _id and the iOS client fails to
    // decode the question payload (no `_id` -> JSON omits the field ->
    // DecodingError.keyNotFound on `id`).
    const inserted = await QuestionBank.insertMany(validated);
    return inserted.map(d => (typeof d.toObject === 'function' ? d.toObject() : d));
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { generateOnDemand, fetchAnchors };
