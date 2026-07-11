'use strict';

/**
 * Decompose Drill grader.
 *
 * Grades a DrillAttempt whose drill_subtype is "decompose".
 * The learner is given a task and must break it into 3-7 AI-handoff steps
 * with rationale per step.  All four rubric dimensions are scored by the LLM.
 */

const { ArtifactBundle, DrillAttempt } = require('../../models');
const { llmCall }              = require('../llmRouter');
const { flattenRubric, recomputeEqualWeighted } = require('./rubric');
const { parseLLMJson }         = require('./parseLLMJson');
const { applyPostGradeUpdates } = require('./postGradeHooks');
const { judgeDrillGrade }       = require('./judgeHook');

// The four scored dimensions (prompt states 25% each), equal-weighted here.
const DECOMPOSE_DIMENSIONS = ['granularity', 'ordering', 'verification_checkpoints', 'ai_handoff_appropriateness'];

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM = `You grade Decompose Drills. The learner is given a task and must break it into 3-7 AI-handoff steps with rationale per step.

Score 0-10 each:
- granularity: steps appropriately sized (not too vague, not too micro)
- ordering: dependencies respected
- verification_checkpoints: does each step say how to verify it
- ai_handoff_appropriateness: each step is something an LLM can do well

For each dimension, also write a short specific 'feedback' sentence (what was strong or what to improve).

Compute overall_score as a weighted blend (granularity 25%, ordering 25%, verification_checkpoints 25%, ai_handoff_appropriateness 25%) on a 0-100 scale (rubric_value * 2.5 each).

Then compare the learner's decomposition_steps to the REFERENCE DECOMPOSITION. For each reference step NOT meaningfully present in the learner's steps (use judgment, not exact match), add an entry to what_you_missed. If the learner covered everything, return an empty array.

Return strict JSON:
{
  "overall_score": <integer 0-100>,
  "rubric": {
    "granularity": { "score": <0-10>, "feedback": "<sentence>" },
    "ordering": { "score": <0-10>, "feedback": "<sentence>" },
    "verification_checkpoints": { "score": <0-10>, "feedback": "<sentence>" },
    "ai_handoff_appropriateness": { "score": <0-10>, "feedback": "<sentence>" }
  },
  "what_to_try_next": "<single sentence, <=200 chars>",
  "what_you_missed": [
    { "title": "Missing step: <short name>", "detail": "<1-2 sentences explaining what was skipped and why it matters>", "reference": "<the reference step text>" }
  ]
}
Return at most 5 entries in what_you_missed. Return an empty array if nothing was missed.`;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Grade a submitted Decompose Drill attempt.
 *
 * Fetches the DrillAttempt + its ArtifactBundle, calls the LLM grader,
 * parses the JSON response, and writes the grade back to the attempt.
 *
 * @param {{ drillAttemptId: import('mongoose').Types.ObjectId | string }} opts
 * @returns {Promise<{ overall_score: number, rubric: object, what_to_try_next: string }>}
 */
async function grade({ drillAttemptId }) {
  const attempt = await DrillAttempt.findById(drillAttemptId).lean();
  if (!attempt) throw new Error(`DrillAttempt ${drillAttemptId} not found`);

  const bundle = await ArtifactBundle.findById(attempt.bundle_id).lean();
  if (!bundle) throw new Error(`ArtifactBundle ${attempt.bundle_id} not found`);

  const ref = (bundle.expected_meta_skill_signals && bundle.expected_meta_skill_signals.decomposition_reference) || [];
  const userMsg = `BRIEF:\n${bundle.brief}\n\nREFERENCE DECOMPOSITION:\n${JSON.stringify(ref)}\n\nLEARNER STEPS:\n${JSON.stringify(attempt.submission.decomposition_steps || [])}`;

  const res = await llmCall({
    taskId:   'drill_grade_decompose',
    system:   SYSTEM,
    messages: [{ role: 'user', content: userMsg }],
    temperature: 0, // deterministic grading (spec §Answer-side deterministic core)
  });

  const parsed = parseLLMJson(res.content);

  // Code-side recompute: overall = equal-weighted mean of the four dims × 10.
  const overall_score = recomputeEqualWeighted(parsed.rubric, DECOMPOSE_DIMENSIONS);

  // ── Answer-side judge (best-effort; skipped when GRADE_JUDGE_SAMPLE_RATE=0) ──
  const regrade = async () => {
    const r2 = await llmCall({ taskId: 'drill_grade_decompose', system: SYSTEM, messages: [{ role: 'user', content: userMsg }], temperature: 0 });
    return { overall: recomputeEqualWeighted(parseLLMJson(r2.content).rubric, DECOMPOSE_DIMENSIONS) };
  };
  const judged = await judgeDrillGrade({ overallScore: overall_score, rubric: parsed.rubric, submission: attempt.submission, regrade });
  const finalScore = judged.overall_score;

  await DrillAttempt.findByIdAndUpdate(drillAttemptId, {
    status: 'graded',
    grade: {
      overall_score:        finalScore,
      rubric_breakdown:     flattenRubric(parsed.rubric),
      what_to_try_next:     parsed.what_to_try_next,
      what_you_missed:      Array.isArray(parsed.what_you_missed) ? parsed.what_you_missed : [],
      // No proctoring/integrity signals exist for drills — 'high' was a lie.
      integrity_confidence: 'unverified',
      needs_review:         judged.needs_review,
      judge_overall:        judged.judge_overall,
      judge_disagreement:   judged.judge_disagreement,
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
    score:        finalScore,
  });

  return { ...parsed, overall_score: finalScore, llm_overall_score: parsed.overall_score, needs_review: judged.needs_review };
}

module.exports = { grade };
