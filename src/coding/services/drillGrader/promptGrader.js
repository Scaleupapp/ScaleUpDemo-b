'use strict';

/**
 * Prompt Drill grader.
 *
 * Grades a DrillAttempt whose drill_subtype is "prompt".
 * The learner is asked to write a prompt that gets an LLM to solve a given
 * brief correctly.  We score them on four rubric dimensions and write the
 * result back to the DrillAttempt document.
 */

const { ArtifactBundle, DrillAttempt } = require('../../models');
const { llmCall }     = require('../llmRouter');
const { flattenRubric } = require('./rubric');

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM = `You grade Prompt Drills. The learner is given a brief and must write a prompt that gets an LLM to solve the task correctly.

Score 0-10 on each rubric dimension:
- specificity: is the prompt specific enough to constrain the model
- constraints: does it declare invariants (format, length, edge cases)
- edge_cases: does it pre-empt failure modes
- output_fidelity: would a typical LLM produce the expected output

Return strict JSON: { overall_score (0-100), rubric: { specificity, constraints, edge_cases, output_fidelity }, what_to_try_next: string (<=200 chars) }`;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Grade a submitted Prompt Drill attempt.
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

  const userMsg = [
    `BRIEF:\n${bundle.brief}`,
    `ACCEPTANCE:\n${(bundle.acceptance_criteria || []).join('\n')}`,
    `LEARNER PROMPT:\n${attempt.submission.prompt_text}`,
    `EXPECTED META-SKILL SIGNALS:\n${JSON.stringify(bundle.expected_meta_skill_signals || {})}`,
  ].join('\n\n');

  const res = await llmCall({
    taskId:   'drill_grade_prompt',
    system:   SYSTEM,
    messages: [{ role: 'user', content: userMsg }],
  });

  const text   = res.content[0].text;
  const parsed = JSON.parse(text);

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
