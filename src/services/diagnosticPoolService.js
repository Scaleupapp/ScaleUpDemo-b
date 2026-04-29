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
const MIN_VIABLE_POOL_SIZE = 3;

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
 * Wraps openai.chat.completions.create with a hard per-call timeout.
 * Uses AbortController so the in-flight HTTP socket is actually closed.
 * Throws on timeout (AbortError), letting the caller's retry logic handle it.
 */
async function _callOpenAIWithTimeout(params, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await openai.chat.completions.create({ ...params }, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Makes one LLM call for a single competency's sub-allocation, retrying once
 * on any failure (including JSON parse errors). Returns validated questions or [].
 */
async function _llmCallForOneCompetency(subAllocation, { objective } = {}) {
  const userPayload = {
    objective: objective || null,
    allocation: subAllocation.map(a => ({
      competency: a.name,
      easy: a.easy, medium: a.medium, hard: a.hard,
    })),
  };

  const competencyName = subAllocation[0]?.name;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const t0 = Date.now();
    console.log(`[diagnosticPoolService] competency='${competencyName}' attempt ${attempt} start`);
    try {
      const resp = await _callOpenAIWithTimeout({
        model: 'gpt-4o-mini',
        temperature: 0.4,
        max_tokens: 2500,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: quizGenerationService.DIAGNOSTIC_QUIZ_SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(userPayload) },
        ],
      });

      const raw = resp?.choices?.[0]?.message?.content;
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.questions)) {
        // Light validation; drop bad rows silently
        const valid = parsed.questions.filter(q =>
          q && typeof q.competency === 'string'
          && ['easy', 'medium', 'hard'].includes(q.difficulty)
          && typeof q.questionText === 'string'
          && Array.isArray(q.options) && q.options.length === 4
          && ['A', 'B', 'C', 'D'].includes(q.correctAnswer)
        );
        console.log(`[diagnosticPoolService] competency='${competencyName}' attempt ${attempt} done in ${Date.now() - t0}ms, ${valid.length} questions`);
        return valid;
      }
    } catch (err) {
      console.warn(`[diagnosticPoolService] competency='${competencyName}' attempt ${attempt} failed in ${Date.now() - t0}ms: ${err.message}`);
    }
  }
  return [];
}

/**
 * Calls gpt-4o-mini to generate a question pool covering the given allocation.
 * Splits into one LLM call per competency so responses stay small and truncation-
 * resistant. Calls run in parallel; a single competency failure does not kill others.
 * Returns a flat array of questions with competency/difficulty tags.
 */
async function generatePoolFromLLM(allocation, ctx = {}) {
  if (!allocation?.length) return [];

  // Group allocation entries by competency name (entries should already be one per
  // competency, but group defensively in case caller merges rows).
  const byCompetency = new Map();
  for (const row of allocation) {
    if (!byCompetency.has(row.name)) byCompetency.set(row.name, []);
    byCompetency.get(row.name).push(row);
  }

  // One LLM call per competency, run in parallel
  const perCompetencyResults = await Promise.all(
    Array.from(byCompetency.values()).map(subAlloc => _llmCallForOneCompetency(subAlloc, ctx)),
  );

  return perCompetencyResults.flat();
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
  const assembleStart = Date.now();
  // Build one cell per (competency, difficulty) and fetch all in parallel (I2)
  const cells = [];
  for (const row of allocation) {
    for (const diff of ['easy', 'medium', 'hard']) {
      const want = row[diff] || 0;
      if (want === 0) continue;
      cells.push({ name: row.name, diff, want });
    }
  }

  // Count how many cells actually need LLM (we won't know until after bank lookup,
  // but log the total cell count now for context).
  console.log(`[diagnosticPoolService] assemblePool start: cells=${cells.length}, competencies=${allocation.length}`);

  const cellResults = await Promise.all(
    cells.map(cell => lookupFromBank(cell.name, cell.diff, cell.want)),
  );

  const out = [];
  const stillNeeded = [];

  for (let i = 0; i < cells.length; i++) {
    const { name, diff, want } = cells[i];
    const fromBank = cellResults[i];
    for (const q of fromBank) {
      out.push({ ...q, competency: name, difficulty: diff });
    }
    const missing = want - fromBank.length;
    if (missing > 0) {
      stillNeeded.push({ name, [diff]: missing });
    }
  }

  console.log(`[diagnosticPoolService] assemblePool: llmFallbackNeeded=${stillNeeded.length > 0} (${stillNeeded.length} cells)`);

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

  const elapsed = Date.now() - assembleStart;

  if (out.length < MIN_VIABLE_POOL_SIZE) {
    console.error(`[diagnosticPoolService] Pool below viable size: ${out.length}/${MIN_VIABLE_POOL_SIZE}, throwing`);
    throw new Error('Could not assemble enough questions; please try again.');
  }

  console.log(`[diagnosticPoolService] Pool assembled: ${out.length} questions in ${elapsed}ms`);

  return out;
}

module.exports = {
  assemblePool,
  _internal: {
    calculatePoolAllocation,
    generatePoolFromLLM,
    _llmCallForOneCompetency,
    _callOpenAIWithTimeout,
    lookupFromBank,
    persistToBank,
    FLOOR_QUESTIONS_PER_COMPETENCY,
    DIFFICULTY_MIX,
    MIN_VIABLE_POOL_SIZE,
  },
};
