'use strict';

/**
 * difficultyRecalibrator.js
 *
 * After each drill grade, computes a recommended next difficulty for the
 * user's role_track using the multi-signal model from spec §5.2.
 * The recommendation is written to DifficultyState.recommendation_history.
 *
 * Phase A implements signals 1-4 (score + time-budget), which are available
 * from the DrillAttempt grade and timing fields.
 *
 * ── Deferred signals (Phase B / out-of-scope) ────────────────────────────────
 * Signal 5: AI-pair effectiveness > rubric expectation → Up
 *   Requires Compass log analysis (Phase B).
 * Signal 6: Verification dimension < 5/10 → Stay (drill verification first)
 *   Requires per-dimension rubric_breakdown inspection and Compass context.
 * Signal 7: Trajectory says objective deadline at risk → Stay or Down
 *   Requires objective-deadline awareness; out of scope for the recalibrator.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Exported:
 *   recordRecommendation({ user_id, role_track, drillAttemptId, accepted? })
 *   applyRecommendation({ user_id, role_track, accepted })
 *   recommendNext({ current_difficulty, score, time_ratio })
 *   computeDirection({ score, time_ratio })
 *   stepUp(difficulty)
 *   stepDown(difficulty)
 */

const { DifficultyState, DrillAttempt, ArtifactBundle } = require('../models');

// ── Difficulty ladder ─────────────────────────────────────────────────────────

const LADDER = ['easy', 'medium', 'hard'];

/**
 * Move one step up the difficulty ladder.
 * step_up('hard') returns 'hard' (capped at top).
 */
function stepUp(d) {
  const i = LADDER.indexOf(d);
  if (i < 0 || i === LADDER.length - 1) return d;
  return LADDER[i + 1];
}

/**
 * Move one step down the difficulty ladder.
 * step_down('easy') returns 'easy' (capped at bottom).
 */
function stepDown(d) {
  const i = LADDER.indexOf(d);
  if (i <= 0) return d;
  return LADDER[i - 1];
}

// ── Multi-signal direction computation (Phase A: signals 1-4) ────────────────

/**
 * Compute the signed direction (+1 up, -1 down, 0 stay) and the list of
 * active signal names for a given score and time_ratio.
 *
 * @param {Object} params
 * @param {number|null} params.score      — overall_score in [0, 100]
 * @param {number|null} params.time_ratio — time_taken / time_budget (seconds)
 * @returns {{ direction: number, signals: string[] }}
 */
function computeDirection({ score, time_ratio }) {
  let direction = 0;
  const signals = [];

  // Signal 1: score > 85 → Up
  // Signal 2: score < 50 → Down
  if (typeof score === 'number') {
    if (score > 85) { direction += 1; signals.push('score>85'); }
    if (score < 50) { direction -= 1; signals.push('score<50'); }
  }

  // Signal 3: used < 60 % of time budget → Up
  // Signal 4: used > 105 % (auto-submit / over time) → Down
  if (typeof time_ratio === 'number') {
    if (time_ratio < 0.6)  { direction += 1; signals.push('time<60%'); }
    if (time_ratio > 1.05) { direction -= 1; signals.push('time>105%'); }
  }

  return { direction, signals };
}

// ── Pure recommendation (no DB) ───────────────────────────────────────────────

/**
 * Compute the next recommended difficulty given the current difficulty and
 * the performance signals.
 *
 * @param {Object} params
 * @param {string}      params.current_difficulty
 * @param {number|null} params.score
 * @param {number|null} params.time_ratio
 * @returns {{ recommended: string, reason: string, signals: string[], direction: number }}
 */
function recommendNext({ current_difficulty, score, time_ratio }) {
  const { direction, signals } = computeDirection({ score, time_ratio });

  let recommended;
  if (direction >= 1)       recommended = stepUp(current_difficulty);
  else if (direction <= -1) recommended = stepDown(current_difficulty);
  else                      recommended = current_difficulty;

  // Build a human-readable reason
  let reason;
  if (signals.length === 0) {
    reason = 'insufficient signal — staying';
  } else if (recommended === current_difficulty && direction !== 0) {
    reason = `signals ${signals.join('+')} but at ladder edge`;
  } else if (recommended === current_difficulty) {
    reason = `mixed signals (${signals.join('+')}) — staying`;
  } else if (direction > 0) {
    reason = `up: ${signals.join('+')}`;
  } else {
    reason = `down: ${signals.join('+')}`;
  }

  return { recommended, reason, signals, direction };
}

// ── DB-backed operations ──────────────────────────────────────────────────────

/**
 * Compute a difficulty recommendation from a graded DrillAttempt and append
 * it to the user's DifficultyState.recommendation_history.
 *
 * Creates a new DifficultyState (starting at 'easy') if none exists yet.
 *
 * @param {Object}  params
 * @param {string}  params.user_id
 * @param {string}  params.role_track
 * @param {string}  params.drillAttemptId
 * @param {boolean|null} [params.accepted=null] — set immediately if known; otherwise null
 * @returns {Promise<{ recommended: string, reason: string, signals: string[], current: string }>}
 */
async function recordRecommendation({ user_id, role_track, drillAttemptId, accepted = null }) {
  if (!user_id || !role_track || !drillAttemptId) {
    throw new Error('user_id, role_track, drillAttemptId required');
  }

  // Fetch and validate the graded attempt
  const attempt = await DrillAttempt.findById(drillAttemptId).lean();
  if (!attempt) throw new Error(`DrillAttempt ${drillAttemptId} not found`);
  if (!attempt.grade || typeof attempt.grade.overall_score !== 'number') {
    throw new Error('DrillAttempt has no grade yet');
  }

  // Fetch the bundle to get the time budget
  const bundle = await ArtifactBundle.findById(attempt.bundle_id).lean();
  if (!bundle) throw new Error('bundle not found');

  const score = attempt.grade.overall_score;
  const time_ratio =
    attempt.time_taken_seconds != null && bundle.time_budget_minutes
      ? attempt.time_taken_seconds / (bundle.time_budget_minutes * 60)
      : null;

  // Find or create the DifficultyState
  let state = await DifficultyState.findOne({ user_id, role_track });
  if (!state) {
    state = new DifficultyState({
      user_id,
      role_track,
      current_difficulty: 'easy',
      recommendation_history: [],
    });
  }

  const { recommended, reason, signals } = recommendNext({
    current_difficulty: state.current_difficulty,
    score,
    time_ratio,
  });

  state.recommendation_history.push({
    recommended,
    reason,
    accepted,           // null until learner explicitly accepts/overrides (via applyRecommendation)
    timestamp: new Date(),
  });

  await state.save();

  return { recommended, reason, signals, current: state.current_difficulty };
}

/**
 * Accept or decline the most recent recommendation.
 *
 * If accepted, advances current_difficulty to the recommended value.
 * If declined, current_difficulty is unchanged.
 *
 * @param {Object}  params
 * @param {string}  params.user_id
 * @param {string}  params.role_track
 * @param {boolean} params.accepted
 * @returns {Promise<{ current_difficulty: string, applied: boolean }>}
 */
async function applyRecommendation({ user_id, role_track, accepted }) {
  const state = await DifficultyState.findOne({ user_id, role_track });
  if (!state) throw new Error('no difficulty state — no recommendation to apply');

  const last = state.recommendation_history[state.recommendation_history.length - 1];
  if (!last) throw new Error('no recommendation history');

  last.accepted = accepted;
  if (accepted) {
    state.current_difficulty = last.recommended;
  }

  await state.save();
  return { current_difficulty: state.current_difficulty, applied: accepted };
}

module.exports = {
  recordRecommendation,
  applyRecommendation,
  recommendNext,
  computeDirection,
  stepUp,
  stepDown,
};
