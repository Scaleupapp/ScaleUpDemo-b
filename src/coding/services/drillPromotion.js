'use strict';

/**
 * Drill activation gate (Wave 4 block 2).
 *
 * A generated drill leaves contentValidator.validate() at status 'validated'
 * (all deterministic + sandbox gates passed, including the REAL
 * checkSeededMistakesFail hard gate). Nothing promoted it to 'active', so the
 * TPO authorDrill poll for an active bundle silently timed out and the
 * scheduled generator produced bundles that were never servable.
 *
 * This module adds the missing promotion: an independent LLM-as-judge pass
 * (cross-family from the Anthropic generator) that scores the validated drill
 * on three question-side dimensions — rubric quality, task clarity, and
 * difficulty honesty — each 1..5. If ANY dimension is <= 2 the drill is
 * rejected (stays 'validated', logged to human review); otherwise it is
 * promoted to 'active' with the judge report + attribution persisted.
 *
 * checkSeededMistakesFail is NOT re-run here: it already ran (and hard-gated)
 * inside contentValidator.validate BEFORE this promotion is ever reached, so a
 * drill whose seeded ground-truth bugs are fictional/undetectable never gets
 * this far. Promotion only ever narrows the active set further.
 *
 * Everything is dependency-injected so tests run with zero network access.
 * Best-effort: a judge error fails CLOSED (no promotion) — an unusable drill is
 * safer than an unvetted one going live.
 */

const models = require('../models');
const llmRouter = require('./llmRouter');

// Any judged dimension at or below this (on the 1..5 scale) rejects the drill.
const REJECT_AT_OR_BELOW = 2;

const JUDGE_SYSTEM_PROMPT =
  'You are an independent reviewer deciding whether a generated coding-practice ' +
  'drill is good enough to serve to learners. You did not write it. Judge it ' +
  'strictly on its own content.';

/**
 * Build the judge user prompt from a validated bundle. We deliberately show the
 * judge the learner-facing brief + acceptance criteria + rubric anchors +
 * (for refactor) the visible tests, and ask for a 1..5 score on each dimension.
 */
function buildJudgePrompt(bundle) {
  const payload = {
    drill_subtype: bundle.drill_subtype,
    role_track: bundle.role_track,
    language: bundle.language,
    difficulty: bundle.difficulty,
    time_budget_minutes: bundle.time_budget_minutes,
    brief: bundle.brief,
    acceptance_criteria: bundle.acceptance_criteria || [],
    rubric_anchors: bundle.rubric_anchors || [],
    visible_tests: (bundle.visible_tests || []).map((t) => ({ name: t.name })),
    seeded_mistake_count: (bundle.seeded_mistakes || []).length,
  };
  return (
    'Review this drill and score it on three dimensions, each an INTEGER 1-5:\n' +
    '  - rubric_quality: are the rubric anchors specific, measurable, and aligned to the task? ' +
    '(5 = every anchor checks a concrete, gradeable signal; 1 = vague/unusable)\n' +
    '  - task_clarity: is the brief unambiguous — could two competent learners interpret the ask the same way ' +
    'and know exactly what "done" means? (5 = crisp; 1 = confusing/underspecified)\n' +
    '  - difficulty_honesty: does the stated difficulty ("' + bundle.difficulty + '") match the actual effort? ' +
    '(easy ~5min, medium ~10min, hard ~15min for a competent learner; 5 = honest label; 1 = badly mislabelled)\n\n' +
    'DRILL:\n' + JSON.stringify(payload, null, 2) + '\n\n' +
    'Return STRICT JSON only (no markdown, no prose): ' +
    '{ "rubric_quality": <1-5>, "task_clarity": <1-5>, "difficulty_honesty": <1-5>, "notes": "<one short sentence>" }'
  );
}

/**
 * Normalise an llmRouter response (Anthropic array / Gemini parts / string)
 * into parsed JSON. Returns null on any failure (fail-closed at the caller).
 */
function parseJudgeResponse(res) {
  let text = '';
  try {
    if (res && res.content && Array.isArray(res.content.parts)) {
      text = res.content.parts.map((p) => p.text || '').join('');
    } else if (res && Array.isArray(res.content)) {
      text = (res.content.find((c) => c && c.text) || {}).text || '';
    } else if (res && typeof res.content === 'string') {
      text = res.content;
    }
    text = text.replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim();
    if (!text) return null;
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

/**
 * Run the promotion judge once.
 *
 * @param {object} bundle
 * @param {object} [deps]  - { llmCall } DI seam (defaults to llmRouter.llmCall)
 * @returns {Promise<{ pass:boolean, scores?:object, notes?:string, error?:string }>}
 */
async function runPromotionJudge(bundle, deps = {}) {
  const llmCall = deps.llmCall || llmRouter.llmCall;
  let res;
  try {
    res = await llmCall({
      taskId: 'drill_promotion_judge',
      system: JUDGE_SYSTEM_PROMPT,
      prompt: buildJudgePrompt(bundle),
    });
  } catch (err) {
    return { pass: false, error: `judge call failed: ${err.message}` };
  }

  const parsed = parseJudgeResponse(res);
  if (!parsed) return { pass: false, error: 'judge returned unparseable output' };

  const dims = ['rubric_quality', 'task_clarity', 'difficulty_honesty'];
  const scores = {};
  for (const d of dims) {
    const n = Number(parsed[d]);
    if (!Number.isFinite(n)) return { pass: false, error: `judge omitted dimension "${d}"`, scores };
    scores[d] = Math.max(1, Math.min(5, Math.round(n)));
  }
  const notes = typeof parsed.notes === 'string' ? parsed.notes : '';
  const failed = dims.filter((d) => scores[d] <= REJECT_AT_OR_BELOW);
  return { pass: failed.length === 0, scores, notes, failedDimensions: failed };
}

/**
 * Promote a validated drill bundle to 'active' iff the judge passes it.
 *
 * No-op (skipped) for non-drills, or bundles not currently 'validated' — so a
 * capstone (which self-activates elsewhere) or an already-active/retired bundle
 * is never touched. The status transition is guarded on { status: 'validated' }
 * so a concurrent state change can never be clobbered.
 *
 * @param {object} opts
 * @param {string} opts.bundle_id
 * @param {object} [deps]  - { ArtifactBundle, HumanReviewQueue, llmCall }
 * @returns {Promise<{ promoted:boolean, skipped?:boolean, reason?:string, scores?:object }>}
 */
async function promoteBundle({ bundle_id }, deps = {}) {
  const ArtifactBundle = deps.ArtifactBundle || models.ArtifactBundle;
  const HumanReviewQueue = deps.HumanReviewQueue || models.HumanReviewQueue;

  const bundle = await ArtifactBundle.findById(bundle_id).lean();
  if (!bundle) return { promoted: false, skipped: true, reason: 'bundle not found' };
  if (bundle.type !== 'drill') return { promoted: false, skipped: true, reason: 'not a drill' };
  if (bundle.status !== 'validated') {
    return { promoted: false, skipped: true, reason: `status is "${bundle.status}", expected "validated"` };
  }

  const judge = await runPromotionJudge(bundle, deps);
  const judge_model = llmRouter.getModelForTask('drill_promotion_judge').model;
  const judgeReport = {
    judged_at: new Date(),
    judge_model,
    scores: judge.scores || null,
    notes: judge.notes || null,
    error: judge.error || null,
  };

  if (!judge.pass) {
    // Stay 'validated' (out of the active/servable pool) and record why. Log to
    // human review so a person can rescue or discard it — never silently active.
    await ArtifactBundle.findOneAndUpdate(
      { _id: bundle_id, status: 'validated' },
      { $set: { 'generated_by.promotion_judge': judgeReport } }
    );
    if (HumanReviewQueue && typeof HumanReviewQueue.create === 'function') {
      try {
        await HumanReviewQueue.create({
          bundle_id,
          reason: 'promotion_judge_rejected',
          validator_errors: [
            judge.error
              ? `promotion judge error: ${judge.error}`
              : `promotion judge rejected: ${(judge.failedDimensions || []).join(', ')} <= ${REJECT_AT_OR_BELOW}`,
          ],
          status: 'pending',
        });
      } catch (_) { /* best-effort */ }
    }
    return { promoted: false, reason: judge.error || 'judge rejected', scores: judge.scores };
  }

  // Judge passed — promote. Guarded on the 'validated' status so we never flip
  // a bundle another process has since moved.
  await ArtifactBundle.findOneAndUpdate(
    { _id: bundle_id, status: 'validated' },
    {
      $set: {
        status: 'active',
        'generated_by.promoted_at': new Date(),
        'generated_by.judge_model': judge_model,
        'generated_by.promotion_judge': judgeReport,
      },
    }
  );
  return { promoted: true, scores: judge.scores };
}

module.exports = { promoteBundle, runPromotionJudge, buildJudgePrompt, parseJudgeResponse };
