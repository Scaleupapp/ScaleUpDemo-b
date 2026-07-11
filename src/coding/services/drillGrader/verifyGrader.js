'use strict';

/**
 * Verify Drill grader.
 *
 * Grades a DrillAttempt whose drill_subtype is "verify".
 * The learner is shown code with planted bugs and must mark each bug's
 * location and explain the root cause.
 *
 * Scoring blends deterministic detection matching with an LLM score for
 * explanation quality:
 *   overall_score = round((detection_accuracy * 0.5 + root_cause_clarity * 0.3 + false_positive_rate * 0.2) * 10)
 *
 * All three sub-dimensions are on a 0-10 scale, so overall_score is 0-100.
 */

const { ArtifactBundle, DrillAttempt } = require('../../models');
const { llmCall }              = require('../llmRouter');
const { flattenRubric }        = require('./rubric');
const { parseLLMJson }         = require('./parseLLMJson');
const { applyPostGradeUpdates } = require('./postGradeHooks');

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM = `You grade Verify Drills. The learner is shown code with planted bugs and must mark each bug + explain.

You will be given the seeded ground truth, the learner's reported bugs, deterministic match counts, and a request to score root_cause_clarity (0-10) based on explanation quality.

For root_cause_clarity, also write a short specific 'feedback' sentence (what was strong or what to improve in the explanations).

Then for each seeded_mistake the learner did NOT find (i.e., its location was not in the matched set), add an entry to what_you_missed. If the learner found everything, return an empty array.

Return strict JSON:
{
  "rubric": {
    "root_cause_clarity": { "score": <0-10>, "feedback": "<sentence>" }
  },
  "what_to_try_next": "<single sentence, <=200 chars>",
  "what_you_missed": [
    { "title": "Missed bug at <file>:<line>", "detail": "<bug_description>", "reference": "<why an LLM would introduce this mistake>" }
  ]
}
Return at most 5 entries in what_you_missed. Return an empty array if the learner found all bugs.`;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns true if a seeded location string ("file:line") matches a reported
 * bug location object ({ file, line }) within ±2 lines of tolerance.
 *
 * @param {string} seededLoc   e.g. "a.py:10"
 * @param {{ file: string, line: number }} reported
 * @returns {boolean}
 */
function locationMatches(seededLoc, reported) {
  const [file, lineStr] = seededLoc.split(':');
  const line = parseInt(lineStr || '0', 10);
  return reported.file === file && Math.abs(reported.line - line) <= 2;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Grade a submitted Verify Drill attempt.
 *
 * Deterministically computes detection_accuracy (fraction of seeded bugs
 * found) and false_positive_rate (penalises spurious reports), then calls
 * the LLM for root_cause_clarity based on explanation quality.
 *
 * @param {{ drillAttemptId: import('mongoose').Types.ObjectId | string }} opts
 * @returns {Promise<{ overall_score: number, rubric: object, what_to_try_next: string }>}
 */
async function grade({ drillAttemptId }) {
  const attempt = await DrillAttempt.findById(drillAttemptId).lean();
  if (!attempt) throw new Error(`DrillAttempt ${drillAttemptId} not found`);

  const bundle = await ArtifactBundle.findById(attempt.bundle_id).lean();
  if (!bundle) throw new Error(`ArtifactBundle ${attempt.bundle_id} not found`);

  const seeded   = bundle.seeded_mistakes || [];
  const reported = attempt.submission.bug_locations || [];

  // ── Deterministic dimensions ──────────────────────────────────────────────

  const matched = reported.filter(r =>
    seeded.some(s => locationMatches(s.location, r))
  );

  const detection_accuracy = seeded.length > 0
    ? (matched.length / seeded.length) * 10
    : 0;

  const false_positives  = reported.length - matched.length;
  const false_positive_rate = Math.max(0, 10 - false_positives * 2);

  // ── LLM dimension: root_cause_clarity ────────────────────────────────────

  const unmatched = seeded.filter(s =>
    !reported.some(r => locationMatches(s.location, r))
  );

  const userMsg = [
    `SEEDED:\n${JSON.stringify(seeded)}`,
    `LEARNER REPORTED:\n${JSON.stringify(reported)}`,
    `MATCHED: ${matched.length}/${seeded.length}`,
    `FALSE POSITIVES: ${false_positives}`,
    `UNMATCHED (not found by learner):\n${JSON.stringify(unmatched)}`,
    `\nScore root_cause_clarity (0-10) based on the quality of the learner's explanations. Populate what_you_missed for each unmatched seeded_mistake.`,
  ].join('\n\n');

  const res = await llmCall({
    taskId:   'drill_grade_verify',
    system:   SYSTEM,
    messages: [{ role: 'user', content: userMsg }],
    temperature: 0, // deterministic grading (spec §Answer-side deterministic core)
  });

  const parsed = parseLLMJson(res.content);
  // root_cause_clarity may be { score, feedback } (new) or a plain number (legacy)
  const rcRaw = parsed.rubric.root_cause_clarity;
  const root_cause_clarity = (rcRaw && typeof rcRaw === 'object' && 'score' in rcRaw)
    ? rcRaw.score
    : rcRaw;

  // ── Blend ─────────────────────────────────────────────────────────────────

  const overall = Math.round(
    (detection_accuracy * 0.5 + root_cause_clarity * 0.3 + false_positive_rate * 0.2) * 10
  );

  // Build full rubric — deterministic dims are plain numbers; LLM dim carries feedback
  const fullRubric = {
    detection_accuracy,
    root_cause_clarity: parsed.rubric.root_cause_clarity,
    false_positive_rate,
  };

  await DrillAttempt.findByIdAndUpdate(drillAttemptId, {
    status: 'graded',
    grade: {
      overall_score:        overall,
      rubric_breakdown:     flattenRubric(fullRubric),
      what_to_try_next:     parsed.what_to_try_next,
      what_you_missed:      Array.isArray(parsed.what_you_missed) ? parsed.what_you_missed : [],
      // No proctoring/integrity signals exist for drills — 'high' was a lie.
      integrity_confidence: 'unverified',
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

module.exports = { grade, locationMatches };
