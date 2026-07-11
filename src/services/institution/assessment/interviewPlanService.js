'use strict';
/**
 * interviewPlanService — question-side QA gates for institution interview
 * assessments (spec §Question-side QA applies to EVERY engine, Wave 2).
 *
 * Interview adaptation of the MCQ 3-gate discipline (no blind-solve — the
 * questions are open-ended):
 *   Gate 1 — deterministic lint on the planned question set (count in range,
 *            no duplicates, one-question-at-a-time formatting, no
 *            answer-revealing preamble, outline present per question).
 *   Gate 2 — an EXPECTED-ANSWER outline is generated per planned question;
 *            this doubles as the grading anchor (threaded into the eval
 *            prompt via InterviewSession.expectedAnswers).
 *   Gate 3 — LLM-as-judge scores the SET on role/company/syllabus relevance,
 *            difficulty honesty, coverage breadth, and answerable-by-a-student
 *            realism (1-5 each; any ≤ 2 rejects the set). Reject ⇒ regenerate
 *            once; still failing ⇒ authoring FAILED (honest status).
 *
 * Generator = OpenAI (same family that conducts the interview); judge =
 * Anthropic via aiProvider (cross-family). All LLM calls DI-stubbable.
 */

const PLAN_MIN_QUESTIONS = 8;
const PLAN_MAX_QUESTIONS = 12;
const MAX_ROUNDS = 2; // initial + one regeneration
const JUDGE_MIN_SCORE = 3; // any dimension ≤ 2 rejects
const JUDGE_DIMENSIONS = ['relevance', 'difficultyHonesty', 'coverage', 'realism'];
const DEDUP_JACCARD = 0.8;

function getAiProvider(deps) {
  return (deps && deps.aiProvider) || require('../../../config/aiProvider');
}

function tokenize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

function jaccard(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ── Gate 1: deterministic lint (pure) ────────────────────────────────────────

/**
 * Lint a planned question set. Returns { passed, failures: string[] }.
 * @param {Array<{question:string, outline:string}>} questions
 * @param {{ questionCount?: number }} [ctx]
 */
function lintPlan(questions, ctx = {}) {
  const failures = [];
  const list = Array.isArray(questions) ? questions : [];

  // Count in range. When the TPO requested an explicit count, honour it; else
  // require the conductor's 8-12 band.
  const min = ctx.questionCount ? Math.min(ctx.questionCount, PLAN_MIN_QUESTIONS) : PLAN_MIN_QUESTIONS;
  const max = ctx.questionCount ? Math.max(ctx.questionCount, PLAN_MAX_QUESTIONS) : PLAN_MAX_QUESTIONS;
  if (list.length < min || list.length > max) failures.push(`bad_count:${list.length}`);

  list.forEach((q, i) => {
    const question = q && typeof q.question === 'string' ? q.question.trim() : '';
    const outline = q && typeof q.outline === 'string' ? q.outline.trim() : '';
    if (!question) failures.push(`missing_question:${i}`);
    if (!outline) failures.push(`missing_outline:${i}`);
    if (!question) return;
    // One question at a time — a compound "…? And also …?" prompt breaks the
    // one-question-per-turn interview contract.
    const qMarks = (question.match(/\?/g) || []).length;
    if (qMarks > 1) failures.push(`multi_question:${i}`);
    // No answer-revealing preamble: the question must not spell out what a
    // good answer contains.
    if (/\b(a strong answer|the ideal answer|the answer is|you should mention|a good response (?:would|should))\b/i.test(question)) {
      failures.push(`answer_leak:${i}`);
    }
  });

  // Intra-set dedup.
  for (let i = 1; i < list.length; i++) {
    for (let j = 0; j < i; j++) {
      if (jaccard(list[i] && list[i].question, list[j] && list[j].question) > DEDUP_JACCARD) {
        failures.push(`duplicate:${i}~${j}`);
        break;
      }
    }
  }

  return { passed: failures.length === 0, failures };
}

// ── Generation (Gate 2 included: outlines are generated with the questions) ──

const GENERATOR_SYSTEM_PROMPT =
  'You plan mock-interview question sets for college placement preparation. ' +
  'Return ONLY valid JSON: {"questions":[{"question":"...","outline":"..."}]} ' +
  'where outline is a 1-3 sentence EXPECTED-ANSWER outline (what a strong ' +
  'candidate answer covers — used privately as a grading anchor, never shown ' +
  'to the candidate). Each question must be a single question (one "?"), ' +
  'self-contained, answerable verbally by a student, and must NOT reveal what ' +
  'a good answer contains.';

async function generatePlan(ctx = {}, deps = {}) {
  const aiProvider = getAiProvider(deps);
  const generate = deps.generateWithGPT || aiProvider.generateWithGPT.bind(aiProvider);
  const count = ctx.questionCount || 10;
  const userPrompt = JSON.stringify({
    task: `Plan exactly ${count} interview questions with expected-answer outlines.`,
    interviewType: ctx.interviewType || 'behavioral',
    targetRole: ctx.targetRole || 'General',
    targetCompany: ctx.targetCompany || null,
    difficulty: ctx.difficulty || 'moderate',
    syllabusContext: ctx.context ? String(ctx.context).slice(0, 4000) : null,
    previousRejectionReasons: ctx.critique || null,
  });
  const parsed = await generate({ systemPrompt: GENERATOR_SYSTEM_PROMPT, userPrompt, temperature: 0.4, maxTokens: 4000 });
  const questions = parsed && Array.isArray(parsed.questions) ? parsed.questions : [];
  return questions.map((q) => ({
    question: q && q.question != null ? String(q.question).trim() : '',
    outline: q && q.outline != null ? String(q.outline).trim() : '',
  }));
}

// ── Gate 3: LLM-as-judge on the set ──────────────────────────────────────────

const JUDGE_SYSTEM_PROMPT =
  'You are a strict interview-content reviewer. You are given a PLANNED mock ' +
  'interview question set (with private expected-answer outlines) and the ' +
  'assessment context. Score the SET as a whole, each an INTEGER 1 (very poor) ' +
  'to 5 (excellent):\n' +
  '- relevance: fit to the role, company, and syllabus/context\n' +
  '- difficultyHonesty: matches the claimed difficulty level\n' +
  '- coverage: breadth across the competencies this interview type should test\n' +
  '- realism: answerable verbally by a student in an interview setting\n' +
  'Respond with ONLY valid JSON: {"scores":{"relevance":n,"difficultyHonesty":n,' +
  '"coverage":n,"realism":n},"notes":"short"}.';

function shapeJudge(result) {
  const out = { scores: {}, verdict: 'reject', valid: false, notes: '', reasons: [] };
  if (!result || typeof result !== 'object' || !result.scores || typeof result.scores !== 'object') {
    out.reasons = ['judge_invalid'];
    return out;
  }
  const low = [];
  for (const dim of JUDGE_DIMENSIONS) {
    const v = Number(result.scores[dim]);
    if (!Number.isFinite(v)) { out.reasons = ['judge_invalid']; return out; }
    out.scores[dim] = v;
    if (v < JUDGE_MIN_SCORE) low.push(dim);
  }
  out.valid = true;
  out.notes = typeof result.notes === 'string' ? result.notes : '';
  out.verdict = low.length === 0 ? 'accept' : 'reject';
  out.reasons = low.map((d) => `judge_low_${d}`);
  return out;
}

async function judgePlan(questions, ctx = {}, deps = {}) {
  const aiProvider = getAiProvider(deps);
  const analyze = deps.analyzeWithClaude || aiProvider.analyzeWithClaude.bind(aiProvider);
  const userPrompt = JSON.stringify({
    interviewType: ctx.interviewType || null,
    targetRole: ctx.targetRole || null,
    targetCompany: ctx.targetCompany || null,
    claimedDifficulty: ctx.difficulty || null,
    syllabusExcerpt: ctx.context ? String(ctx.context).slice(0, 2000) : null,
    questions,
  });
  let result;
  try {
    result = await analyze({ systemPrompt: JUDGE_SYSTEM_PROMPT, userPrompt, temperature: 0, maxTokens: 500 });
  } catch (err) {
    return { scores: {}, verdict: 'reject', valid: false, notes: '', reasons: ['judge_error'] };
  }
  return shapeJudge(result);
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Generate + gate a question plan (max 2 rounds).
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   questions?: Array<{question, outline}>,
 *   judge?: object, lint?: object, rounds: number, error?: string
 * }>}
 */
async function buildQuestionPlan(ctx = {}, deps = {}) {
  const genFn = deps.generatePlan || generatePlan;
  const judgeFn = deps.judgePlan || judgePlan;
  let lastError = 'plan generation produced nothing';
  let critique = null;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let questions;
    try {
      questions = await genFn({ ...ctx, critique }, deps);
    } catch (err) {
      lastError = `generation failed: ${err.message}`;
      critique = lastError;
      continue;
    }

    const lint = lintPlan(questions, ctx);
    if (!lint.passed) {
      lastError = `lint failed: ${lint.failures.join(', ')}`;
      critique = lastError;
      continue;
    }

    const judge = await judgeFn(questions, ctx, deps);
    if (judge.verdict !== 'accept') {
      lastError = `judge rejected: ${(judge.reasons || []).join(', ')}${judge.notes ? ` — ${judge.notes}` : ''}`;
      critique = lastError;
      continue;
    }

    return { ok: true, questions, judge, lint, rounds: round + 1 };
  }

  return { ok: false, rounds: MAX_ROUNDS, error: lastError };
}

module.exports = {
  buildQuestionPlan,
  generatePlan,
  judgePlan,
  lintPlan,
  shapeJudge,
  constants: { PLAN_MIN_QUESTIONS, PLAN_MAX_QUESTIONS, MAX_ROUNDS, JUDGE_MIN_SCORE, JUDGE_DIMENSIONS, DEDUP_JACCARD },
  _helpers: { jaccard, tokenize },
};
