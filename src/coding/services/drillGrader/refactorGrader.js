'use strict';

/**
 * Refactor Drill grader — sandbox-aware.
 *
 * Runs the bundle's visible_tests against the learner's refactored_code.files
 * inside the local sandbox to determine correctness deterministically, then
 * asks the LLM to score readability_gain and ai_usage_judgment.
 *
 * Score blend:
 *   overall_score = round((correctness * 0.5 + readability_gain * 0.25 + ai_usage_judgment * 0.25) * 10)
 *
 * All dimensions are on a 0-10 scale; overall_score is 0-100.
 *
 * Note: Phase B will replace localSandbox with a managed cloud sandbox.
 */

const { ArtifactBundle, DrillAttempt } = require('../../models');
const { llmCall }              = require('../llmRouter');
const { flattenRubric }        = require('./rubric');
const { parseLLMJson }         = require('./parseLLMJson');
const sandbox                  = require('../sandbox/localSandbox');
const { applyPostGradeUpdates } = require('./postGradeHooks');

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM = `You grade Refactor-with-AI Drills. The learner refactored code using Compass. You see the original, the refactored result, the reference solution, and the test pass/fail count.

Score 0-10:
- readability_gain: is the refactor genuinely clearer / better factored than the original
- ai_usage_judgment: did they use Compass well (good prompts, accept/reject judgment)

For each dimension, also write a short specific 'feedback' sentence (what was strong or what to improve).

correctness is already computed deterministically and provided to you. Do not score correctness.

Then compare the learner's refactored code to the REFERENCE SOLUTION. For each significant improvement present in the reference but missing from the learner's version, add an entry to what_you_missed. If the learner matched the reference quality, return an empty array.

Return strict JSON:
{
  "rubric": {
    "readability_gain": { "score": <0-10>, "feedback": "<sentence>" },
    "ai_usage_judgment": { "score": <0-10>, "feedback": "<sentence>" }
  },
  "what_to_try_next": "<single sentence, <=200 chars>",
  "what_you_missed": [
    { "title": "<short headline>", "detail": "<1-2 sentences>", "reference": "<the missing improvement from the reference solution>" }
  ]
}
Return at most 5 entries in what_you_missed. Return an empty array if nothing significant was missed.`;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Grade a submitted Refactor Drill attempt.
 *
 * Runs visible_tests inside the local sandbox to compute a deterministic
 * correctness score, then calls the LLM for readability_gain and
 * ai_usage_judgment.
 *
 * @param {{ drillAttemptId: import('mongoose').Types.ObjectId | string }} opts
 * @returns {Promise<{ overall_score: number, rubric: object, what_to_try_next: string }>}
 */
async function grade({ drillAttemptId }) {
  const attempt = await DrillAttempt.findById(drillAttemptId).lean();
  if (!attempt) throw new Error(`DrillAttempt ${drillAttemptId} not found`);

  const bundle = await ArtifactBundle.findById(attempt.bundle_id).lean();
  if (!bundle) throw new Error(`ArtifactBundle ${attempt.bundle_id} not found`);

  const files = (
    attempt.submission &&
    attempt.submission.refactored_code &&
    attempt.submission.refactored_code.files
  ) || [];

  const tests = bundle.visible_tests || [];

  // ── Deterministic dimension: correctness ──────────────────────────────────

  let passed = 0;
  if (tests.length > 0) {
    const testResults = await Promise.all(
      tests.map(t => sandbox.runInTempDir({ files, command: t.command, timeout_ms: 15000 }))
    );

    passed = testResults.filter((r, i) => {
      const expectedExit = (tests[i] && tests[i].expected_exit_code !== undefined)
        ? tests[i].expected_exit_code
        : 0;
      return r.exit_code === expectedExit;
    }).length;
  }

  // When there are no tests the bundle cannot penalise — full credit.
  const totalTests  = tests.length > 0 ? tests.length : 1;
  const passedCount = tests.length > 0 ? passed : 1;
  const correctness = (passedCount / totalTests) * 10;

  // ── LLM dimensions: readability_gain + ai_usage_judgment ─────────────────

  const originalFiles = (bundle.starter_repo && bundle.starter_repo.files) || [];
  const referenceFiles = (bundle.reference_solution && bundle.reference_solution.files) || [];
  const userMsg = [
    `ORIGINAL CODE:\n${JSON.stringify(originalFiles)}`,
    `REFACTORED:\n${JSON.stringify(files)}`,
    referenceFiles.length > 0 ? `REFERENCE SOLUTION:\n${JSON.stringify(referenceFiles)}` : '',
    `TEST RESULTS: ${passed}/${tests.length} passed`,
    `Score readability_gain and ai_usage_judgment. Populate what_you_missed for significant improvements present in the reference but absent in the refactored code.`,
  ].filter(Boolean).join('\n\n');

  const res = await llmCall({
    taskId:   'drill_grade_refactor',
    system:   SYSTEM,
    messages: [{ role: 'user', content: userMsg }],
  });

  const parsed = parseLLMJson(res.content);
  // readability_gain / ai_usage_judgment may be { score, feedback } (new) or plain numbers (legacy)
  const rgRaw  = parsed.rubric.readability_gain;
  const aujRaw = parsed.rubric.ai_usage_judgment;
  const readability_gain  = (rgRaw  && typeof rgRaw  === 'object' && 'score' in rgRaw)  ? rgRaw.score  : rgRaw;
  const ai_usage_judgment = (aujRaw && typeof aujRaw === 'object' && 'score' in aujRaw) ? aujRaw.score : aujRaw;

  // ── Blend ─────────────────────────────────────────────────────────────────

  const overall = Math.round(
    (correctness * 0.5 + readability_gain * 0.25 + ai_usage_judgment * 0.25) * 10
  );

  // Build full rubric — correctness is deterministic (plain number); LLM dims carry feedback
  const fullRubric = {
    correctness,
    readability_gain:  parsed.rubric.readability_gain,
    ai_usage_judgment: parsed.rubric.ai_usage_judgment,
  };

  await DrillAttempt.findByIdAndUpdate(drillAttemptId, {
    status: 'graded',
    grade: {
      overall_score:        overall,
      rubric_breakdown:     flattenRubric(fullRubric),
      what_to_try_next:     parsed.what_to_try_next,
      what_you_missed:      Array.isArray(parsed.what_you_missed) ? parsed.what_you_missed : [],
      integrity_confidence: 'high',
      graded_at:            new Date(),
      grader_model:         res._meta.model,
    },
  });

  // Propagate the grade into Mastery + Difficulty (best-effort, never throws)
  await applyPostGradeUpdates({
    drillAttemptId,
    userId:       attempt.user_id,
    roleTrack:    bundle.role_track,
    drillSubtype: bundle.drill_subtype,
    score:        overall,
  });

  return {
    overall_score: overall,
    rubric: fullRubric,
    what_to_try_next: parsed.what_to_try_next,
    what_you_missed: Array.isArray(parsed.what_you_missed) ? parsed.what_you_missed : [],
  };
}

module.exports = { grade };
