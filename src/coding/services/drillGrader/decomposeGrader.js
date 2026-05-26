'use strict';

/**
 * Decompose Drill grader.
 *
 * Grades a DrillAttempt whose drill_subtype is "decompose".
 * The learner is given a task and must break it into 3-7 AI-handoff steps
 * with rationale per step.  All four rubric dimensions are scored by the LLM.
 */

const { ArtifactBundle, DrillAttempt } = require('../../models');
const { llmCall }       = require('../llmRouter');
const { flattenRubric } = require('./rubric');

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM = `You grade Decompose Drills. The learner is given a task and must break it into 3-7 AI-handoff steps with rationale per step.

Score 0-10 each:
- granularity: steps appropriately sized (not too vague, not too micro)
- ordering: dependencies respected
- verification_checkpoints: does each step say how to verify it
- ai_handoff_appropriateness: each step is something an LLM can do well

Compute overall_score as a weighted blend (granularity 25%, ordering 25%, verification_checkpoints 25%, ai_handoff_appropriateness 25%) on a 0-100 scale (rubric_value * 2.5 each).

Return strict JSON: { overall_score (0-100), rubric: { granularity, ordering, verification_checkpoints, ai_handoff_appropriateness }, what_to_try_next: string (<=200 chars) }`;

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
  });

  const parsed = JSON.parse(res.content[0].text);

  await DrillAttempt.findByIdAndUpdate(drillAttemptId, {
    status: 'graded',
    grade: {
      overall_score:        parsed.overall_score,
      rubric_breakdown:     flattenRubric(parsed.rubric),
      what_to_try_next:     parsed.what_to_try_next,
      integrity_confidence: 'high',
      graded_at:            new Date(),
      grader_model:         res._meta.model,
    },
  });

  return parsed;
}

module.exports = { grade };
