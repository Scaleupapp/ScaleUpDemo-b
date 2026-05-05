const openai = require('../../config/openai');
const budget = require('./llmCallBudget');
const { withRetry } = require('./withRetry');

const VALIDATOR_SCHEMA = {
  name: 'question_validation',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      score: { type: 'integer', minimum: 0, maximum: 100 },
      critique: { type: 'string' },
      issues: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: ['score', 'critique', 'issues'],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = `You are a strict quality reviewer for diagnostic assessment questions used by Indian working professionals and students. Find what is wrong, not what is right.

Score 0-100 based on:
- Correctness: Is the marked answer unambiguously correct? Are other options unambiguously wrong?
- Difficulty calibration: Does the actual difficulty match the stated difficulty?
- Language quality: Grammar, clarity, no double negatives, no leading wording
- Single-correct-answer: No two options that could both be defensible
- No ambiguity: Question stem complete enough to answer
- No offensive content
- India context: Examples make sense for Indian learners (where applicable)
- Real-world feel: Not textbook-rote / definition-recall

Score guide:
- 90-100: ship as is
- 70-89: usable but has minor issues
- 0-69: do not use, list specific issues

Be honest. A textbook definition question scores 60-70 max.`;

function classifyScore(score) {
  if (score >= 90) return 'auto_verified';
  if (score >= 70) return 'pending';
  return 'flagged_for_review';
}

function buildUserPrompt(question) {
  const optionsText = question.options
    .map(o => `${o.label}. ${o.text}`)
    .join('\n');
  return `Topic: ${question.canonicalCompetency}
Stated difficulty: ${question.difficulty}

Question:
${question.questionText}

Options:
${optionsText}

Marked correct: ${question.correctAnswer}

Critique this question.`;
}

async function validateQuestion(question, opts = {}) {
  const timeoutMs = opts.timeoutMs || 12000;
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
            { role: 'user', content: buildUserPrompt(question) },
          ],
          response_format: { type: 'json_schema', json_schema: VALIDATOR_SCHEMA },
          temperature: 0.2,
          max_tokens: 500,
        },
        { signal: controller.signal }
      )
    );

    const raw = completion.choices[0].message.content;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return {
        score: 0,
        critique: `Validator response failed to parse: ${e.message}`,
        issues: ['parse_failure'],
        status: 'flagged_for_review',
      };
    }
    return {
      score: parsed.score,
      critique: parsed.critique,
      issues: parsed.issues || [],
      status: classifyScore(parsed.score),
    };
  } catch (e) {
    return {
      score: 0,
      critique: `Validator failed: ${e.message}`,
      issues: ['validator_error'],
      status: 'flagged_for_review',
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { validateQuestion, classifyScore };
