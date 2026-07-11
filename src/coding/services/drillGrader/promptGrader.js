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
const { llmCall }              = require('../llmRouter');
const { flattenRubric, recomputeEqualWeighted } = require('./rubric');
const { parseLLMJson }         = require('./parseLLMJson');
const { applyPostGradeUpdates } = require('./postGradeHooks');
const { judgeDrillGrade }       = require('./judgeHook');

// The four scored dimensions, equal-weighted for the code-side overall recompute.
const PROMPT_DIMENSIONS = ['specificity', 'constraints', 'edge_cases', 'output_fidelity'];

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM = `You grade Prompt Drills. The learner is given a brief and must write a prompt that gets an LLM to solve the task correctly.

Score 0-10 on each rubric dimension:
- specificity: is the prompt specific enough to constrain the model
- constraints: does it declare invariants (format, length, edge cases)
- edge_cases: does it pre-empt failure modes
- output_fidelity: would a typical LLM produce the expected output

For each dimension, also write a short specific 'feedback' sentence (what was strong or what to improve).

Then compare the learner's prompt to "good_prompts_look_like" from EXPECTED META-SKILL SIGNALS. For each element in that list NOT present in the learner's prompt, add an entry to what_you_missed. If the learner covered everything well, return an empty array for what_you_missed.

Return strict JSON:
{
  "overall_score": <integer 0-100>,
  "rubric": {
    "specificity": { "score": <0-10>, "feedback": "<sentence>" },
    "constraints": { "score": <0-10>, "feedback": "<sentence>" },
    "edge_cases": { "score": <0-10>, "feedback": "<sentence>" },
    "output_fidelity": { "score": <0-10>, "feedback": "<sentence>" }
  },
  "what_to_try_next": "<single sentence, <=200 chars>",
  "what_you_missed": [
    { "title": "<headline>", "detail": "<1-2 sentences>", "reference": "<the missing element>" }
  ]
}
Return at most 5 entries in what_you_missed. Return an empty array if nothing was missed.`;

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
    temperature: 0, // deterministic grading (spec §Answer-side deterministic core)
  });

  const parsed = parseLLMJson(res.content);

  // Code-side recompute: overall = equal-weighted mean of the four rubric
  // dimensions × 10 (the four dims carry no stated weights ⇒ 25% each). The
  // LLM's self-reported overall_score is NOT trusted for the stored number.
  const overall_score = recomputeEqualWeighted(parsed.rubric, PROMPT_DIMENSIONS);

  // ── Answer-side judge (best-effort; skipped when GRADE_JUDGE_SAMPLE_RATE=0) ──
  const regrade = async () => {
    const r2 = await llmCall({ taskId: 'drill_grade_prompt', system: SYSTEM, messages: [{ role: 'user', content: userMsg }], temperature: 0 });
    return { overall: recomputeEqualWeighted(parseLLMJson(r2.content).rubric, PROMPT_DIMENSIONS) };
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

  // Return the (judge-reconciled) code-recomputed overall; retain the LLM number.
  return { ...parsed, overall_score: finalScore, llm_overall_score: parsed.overall_score, needs_review: judged.needs_review };
}

module.exports = { grade };
