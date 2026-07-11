'use strict';

/**
 * gradeJudgeService — answer-side LLM-as-judge on grades (spec §Answer-side #3).
 *
 * An INDEPENDENT judge (a different model family from the grader where feasible)
 * receives the evidence (interview transcript / capstone code+test results /
 * drill submission), the rubric, and the grader's dimension + overall scores,
 * and returns a concur/adjust overall. If |overall disagreement| > 15 points we
 * auto re-grade ONCE; if the re-grade converges with the judge we accept the
 * average, otherwise we flag `needsReview` for admin/TPO surfacing.
 *
 * All three current graders (interview, capstone, drills) are ANTHROPIC, so the
 * default judge runs on OpenAI via aiProvider.generateWithGPT ("different family
 * from the grader where feasible"). Everything is dependency-injected so tests
 * run with zero network access. The whole thing is best-effort: a judge error
 * NEVER bricks a grade (fail-open, no needsReview on judge failure).
 *
 * Sampling: env GRADE_JUDGE_SAMPLE_RATE (default 1.0 = 100% coverage).
 */

const DISAGREEMENT_THRESHOLD = 15; // points on the 0-100 overall scale

function num(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }

function sampleRateFromEnv() {
  const raw = process.env.GRADE_JUDGE_SAMPLE_RATE;
  if (raw == null || raw === '') return 1.0;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1.0;
}

const JUDGE_SYSTEM_PROMPT =
  'You are an independent grading auditor. You are given the EVIDENCE from an ' +
  'assessment, the RUBRIC, and another grader\'s DIMENSION scores and OVERALL ' +
  'score (0-100). Judge, using only the evidence, whether the overall score is ' +
  'defensible. Return your own independent overall score. Respond with ONLY ' +
  'valid JSON: {"overall": <0-100 number>, "concurs": <boolean>, ' +
  '"notes": "<one short sentence>"}.';

/**
 * Build the judge user prompt from an engine-agnostic evidence envelope.
 */
function buildJudgePrompt({ engine, evidence, rubric, graderResult }) {
  return JSON.stringify({
    engine: engine || 'unknown',
    rubric: rubric || null,
    grader: {
      overall: num(graderResult && graderResult.overall),
      dimensions: (graderResult && graderResult.dimensions) || null,
    },
    evidence: typeof evidence === 'string' ? evidence.slice(0, 12000) : evidence,
  });
}

/**
 * Default judge LLM caller — OpenAI (cross-family from the Anthropic graders).
 * Returns the parsed JSON object or throws.
 */
function defaultJudgeLlm(deps) {
  if (deps && typeof deps.judgeLlm === 'function') return deps.judgeLlm;
  const aiProvider = (deps && deps.aiProvider) || require('../../config/aiProvider');
  return async ({ systemPrompt, userPrompt }) =>
    aiProvider.generateWithGPT({ systemPrompt, userPrompt, temperature: 0, maxTokens: 400 });
}

/**
 * Run the judge once. Returns { valid, overall, concurs, notes } — never throws.
 */
async function runJudge({ engine, evidence, rubric, graderResult }, deps = {}) {
  const call = defaultJudgeLlm(deps);
  let parsed;
  try {
    parsed = await call({
      systemPrompt: JUDGE_SYSTEM_PROMPT,
      userPrompt: buildJudgePrompt({ engine, evidence, rubric, graderResult }),
    });
  } catch (err) {
    return { valid: false, overall: null, concurs: null, notes: '', error: err.message };
  }
  if (!parsed || typeof parsed !== 'object' || !Number.isFinite(Number(parsed.overall))) {
    return { valid: false, overall: null, concurs: null, notes: '' };
  }
  return {
    valid: true,
    overall: Math.max(0, Math.min(100, Number(parsed.overall))),
    concurs: typeof parsed.concurs === 'boolean' ? parsed.concurs : undefined,
    notes: typeof parsed.notes === 'string' ? parsed.notes : '',
  };
}

/**
 * Reconcile a grade against an independent judge.
 *
 * @param {object} args
 * @param {string}   args.engine        — 'interview' | 'capstone' | 'drill'
 * @param {*}        args.evidence       — transcript / code+tests / submission
 * @param {*}        args.rubric         — rubric summary given to the judge
 * @param {{overall:number, dimensions?:object}} args.graderResult
 * @param {() => Promise<{overall:number}>} [args.regrade] — one auto re-grade
 * @param {number}  [args.sampleRate]    — override GRADE_JUDGE_SAMPLE_RATE
 * @param {object}  [deps]               — { judgeLlm | aiProvider, rng, runJudge }
 * @returns {Promise<{
 *   sampled:boolean, needsReview:boolean, regraded:boolean,
 *   judgeOverall:number|null, disagreement:number|null,
 *   finalOverall:number|null, secondOverall?:number, judge:object|null
 * }>}
 */
async function reconcile(args = {}, deps = {}) {
  const { engine, evidence, rubric, graderResult, regrade } = args;
  const rate = args.sampleRate != null ? args.sampleRate : sampleRateFromEnv();
  const rng = deps.rng || Math.random;
  const judgeFn = deps.runJudge || runJudge;

  const graderOverall = num(graderResult && graderResult.overall);
  const base = {
    sampled: false, needsReview: false, regraded: false,
    judgeOverall: null, disagreement: null, finalOverall: graderOverall, judge: null,
  };

  // Sampling gate.
  if (!(rate >= 1) && rng() >= rate) return base;

  const judge = await judgeFn({ engine, evidence, rubric, graderResult }, deps);
  // Judge unavailable/invalid ⇒ fail-open: keep the grade, no needsReview.
  if (!judge || !judge.valid) {
    return { ...base, sampled: true, judge: judge || null };
  }

  const disagreement1 = Math.abs(graderOverall - judge.overall);
  if (disagreement1 <= DISAGREEMENT_THRESHOLD) {
    return {
      sampled: true, needsReview: false, regraded: false,
      judgeOverall: judge.overall, disagreement: disagreement1,
      finalOverall: graderOverall, judge,
    };
  }

  // Divergent — one auto re-grade (if the caller supplied a regrade fn).
  if (typeof regrade !== 'function') {
    return {
      sampled: true, needsReview: true, regraded: false,
      judgeOverall: judge.overall, disagreement: disagreement1,
      finalOverall: graderOverall, judge,
    };
  }

  let second;
  try {
    second = await regrade();
  } catch (err) {
    // Re-grade failed — flag for review rather than silently trusting the first.
    return {
      sampled: true, needsReview: true, regraded: false,
      judgeOverall: judge.overall, disagreement: disagreement1,
      finalOverall: graderOverall, judge, regradeError: err.message,
    };
  }

  const secondOverall = num(second && second.overall);
  const disagreement2 = Math.abs(secondOverall - judge.overall);
  if (disagreement2 <= DISAGREEMENT_THRESHOLD) {
    // Converged — accept the average of the two grader passes.
    return {
      sampled: true, needsReview: false, regraded: true,
      judgeOverall: judge.overall, disagreement: disagreement2,
      finalOverall: Math.round((graderOverall + secondOverall) / 2),
      secondOverall, judge,
    };
  }

  // Still divergent after a re-grade — flag for human review.
  return {
    sampled: true, needsReview: true, regraded: true,
    judgeOverall: judge.overall, disagreement: disagreement2,
    finalOverall: secondOverall, secondOverall, judge,
  };
}

module.exports = {
  reconcile,
  runJudge,
  DISAGREEMENT_THRESHOLD,
  _helpers: { num, sampleRateFromEnv, buildJudgePrompt },
};
