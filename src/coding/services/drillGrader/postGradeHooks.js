'use strict';

/**
 * postGradeHooks.js
 *
 * After a drill grade is written, propagate the result into the rest of the
 * platform: update the user's meta-skill mastery and record a next-difficulty
 * recommendation.
 *
 * This is the bridge that turns a drill score into a learning loop. Without it,
 * grades are written but never feed forward — Mastery stays at 0, Difficulty
 * never recalibrates, Readiness ramp never starts.
 *
 * Called by all 4 drill graders after their `findByIdAndUpdate(...status:'graded')` write.
 *
 * Best-effort: errors are logged but don't throw, because the grade itself is
 * already saved. We don't want a downstream service blip to make the grade
 * look failed.
 *
 * @param {object} params
 * @param {string|import('mongoose').Types.ObjectId} params.drillAttemptId
 * @param {string|import('mongoose').Types.ObjectId} params.userId
 * @param {string} params.roleTrack    e.g. 'swe' (already known by the grader)
 * @param {string} params.drillSubtype e.g. 'prompt' | 'verify' | 'decompose' | 'refactor'
 * @param {number} params.score        0-100
 * @returns {Promise<{ mastery: object|null, recommendation: object|null }>}
 */
async function applyPostGradeUpdates({ drillAttemptId, userId, roleTrack, drillSubtype, score }) {
  if (!drillAttemptId || !userId || !roleTrack || !drillSubtype || typeof score !== 'number') {
    console.error('[postGradeHooks] missing params', { drillAttemptId, userId, roleTrack, drillSubtype, score });
    return { mastery: null, recommendation: null };
  }

  let mastery = null;
  let recommendation = null;

  // 1. Mastery delta — exponential moving average into the relevant axis
  try {
    const { applyMasteryDelta } = require('../masteryDelta');
    mastery = await applyMasteryDelta({
      user_id: userId,
      role_track: roleTrack,
      drill_subtype: drillSubtype,
      score,
    });
  } catch (err) {
    console.error('[postGradeHooks] applyMasteryDelta failed:', err.message);
  }

  // 2. Difficulty recommendation — records the next-difficulty suggestion
  //    based on this attempt's score + time ratio.
  try {
    const { recordRecommendation } = require('../difficultyRecalibrator');
    recommendation = await recordRecommendation({
      user_id: userId,
      role_track: roleTrack,
      drillAttemptId,
    });
  } catch (err) {
    console.error('[postGradeHooks] recordRecommendation failed:', err.message);
  }

  return { mastery, recommendation };
}

module.exports = { applyPostGradeUpdates };
