/**
 * Diagnostic Pool Service — generates question pools for a diagnostic attempt.
 *
 * Two responsibilities:
 *   1. Calculate the pool size + difficulty distribution given (competencies, totalSize)
 *   2. Generate the pool by combining bank lookups with live LLM calls
 *
 * This file holds the calculator. LLM/bank integration arrives in later tasks.
 */

const openai = require('../config/openai');
const quizGenerationService = require('./quizGenerationService');
const DiagnosticQuestionBank = require('../models/DiagnosticQuestionBank');
const { normalize } = require('./competencyNormalizer');

const FLOOR_QUESTIONS_PER_COMPETENCY = 3;
const DEFAULT_POOL_SIZE = 24;

// Difficulty distribution per self-rating, expressed as proportions
// over the per-competency allocation.
const DIFFICULTY_MIX = {
  novice:     { easy: 0.60, medium: 0.25, hard: 0.15 },
  unsure:     { easy: 0.60, medium: 0.25, hard: 0.15 },
  familiar:   { easy: 0.40, medium: 0.50, hard: 0.10 },
  proficient: { easy: 0.25, medium: 0.50, hard: 0.25 },
  expert:     { easy: 0.10, medium: 0.40, hard: 0.50 },
};

/**
 * Returns one allocation entry per competency with per-difficulty integer counts.
 * Total across all competencies will be approximately `totalPoolSize`, with a
 * hard floor of FLOOR_QUESTIONS_PER_COMPETENCY per competency.
 */
function calculatePoolAllocation(competencies, totalPoolSize = DEFAULT_POOL_SIZE) {
  if (!competencies?.length) return [];
  const perCompetency = Math.max(
    FLOOR_QUESTIONS_PER_COMPETENCY,
    Math.round(totalPoolSize / competencies.length),
  );
  return competencies.map(c => {
    const mix = DIFFICULTY_MIX[c.selfRating] || DIFFICULTY_MIX.unsure;
    const easy   = Math.max(1, Math.round(perCompetency * mix.easy));
    const hard   = Math.max(1, Math.round(perCompetency * mix.hard));
    const medium = Math.max(1, perCompetency - easy - hard);
    return { name: c.name, easy, medium, hard };
  });
}

/**
 * Calls gpt-4o-mini to generate a question pool covering the given allocation.
 * Returns a flat array of questions with competency/difficulty tags. Returns
 * empty array on any failure (caller falls back to bank-only path).
 */
async function generatePoolFromLLM(allocation, { objective } = {}) {
  if (!allocation?.length) return [];

  const userPayload = {
    objective: objective || null,
    allocation: allocation.map(a => ({
      competency: a.name,
      easy: a.easy, medium: a.medium, hard: a.hard,
    })),
  };

  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.4,
      max_tokens: 3000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: quizGenerationService.DIAGNOSTIC_QUIZ_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(userPayload) },
      ],
    });

    const raw = resp?.choices?.[0]?.message?.content;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.questions)) return [];

    // Light validation; drop bad rows silently
    return parsed.questions.filter(q =>
      q && typeof q.competency === 'string'
      && ['easy', 'medium', 'hard'].includes(q.difficulty)
      && typeof q.questionText === 'string'
      && Array.isArray(q.options) && q.options.length === 4
      && ['A', 'B', 'C', 'D'].includes(q.correctAnswer)
    );
  } catch (err) {
    console.warn('[diagnosticPoolService] generatePoolFromLLM failed:', err.message);
    return [];
  }
}

/**
 * Look up cached questions for a (competency, difficulty) bucket. Returns up to
 * `limit` documents, prioritising least-used (round-robin so we don't burn a
 * single question on every diagnostic).
 */
async function lookupFromBank(competency, difficulty, limit) {
  const canonical = normalize(competency);
  if (!canonical) return [];
  return DiagnosticQuestionBank
    .find({ canonicalCompetency: canonical, difficulty, status: 'active' })
    .sort({ timesUsed: 1, generatedAt: -1 })
    .limit(limit)
    .lean();
}

/**
 * Persist freshly-generated questions to the bank. Normalises competency
 * names so future lookups hit cache regardless of how the user phrased it.
 */
async function persistToBank(generatedQuestions) {
  if (!generatedQuestions?.length) return [];
  const docs = generatedQuestions.map(q => ({
    canonicalCompetency: normalize(q.competency),
    rawCompetencyAliases: [q.competency],
    difficulty: q.difficulty,
    questionText: q.questionText,
    options: q.options,
    correctAnswer: q.correctAnswer,
    explanation: q.explanation,
    source: 'live_generated',
  }));
  return DiagnosticQuestionBank.insertMany(docs);
}

/**
 * Public entry point: produce a pool that satisfies the allocation.
 * Strategy: try bank first per (competency, difficulty), fall back to LLM
 * for whatever's missing, then persist the LLM-generated questions for next time.
 */
async function assemblePool(allocation, ctx = {}) {
  const out = [];
  const stillNeeded = []; // allocation rows that need LLM top-up

  for (const row of allocation) {
    for (const diff of ['easy', 'medium', 'hard']) {
      const want = row[diff] || 0;
      if (want === 0) continue;
      const fromBank = await lookupFromBank(row.name, diff, want);
      for (const q of fromBank) {
        out.push({
          ...q,
          competency: row.name,
          difficulty: diff,
        });
      }
      const missing = want - fromBank.length;
      if (missing > 0) {
        stillNeeded.push({ name: row.name, [diff]: missing });
      }
    }
  }

  if (stillNeeded.length > 0) {
    const generated = await generatePoolFromLLM(stillNeeded, ctx);
    out.push(...generated);
    // Persist for next time
    if (generated.length > 0) {
      await persistToBank(generated).catch(err =>
        console.warn('[diagnosticPoolService] persistToBank failed:', err.message),
      );
    }
  }

  return out;
}

module.exports = {
  assemblePool,
  _internal: {
    calculatePoolAllocation,
    generatePoolFromLLM,
    lookupFromBank,
    persistToBank,
    FLOOR_QUESTIONS_PER_COMPETENCY,
    DIFFICULTY_MIX,
  },
};
