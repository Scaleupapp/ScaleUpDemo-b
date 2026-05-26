'use strict';

/**
 * masteryDelta.js
 *
 * Updates a user's MetaSkillMastery document using an exponential moving
 * average (EMA) blend whenever a drill is graded.
 *
 * Exported:
 *   applyMasteryDelta({ user_id, role_track, drill_subtype, score })
 *   emaAlpha(attemptCount)   — pure helper, exported for testing
 *   clamp(value, min, max)   — pure helper, exported for testing
 */

const { MetaSkillMastery } = require('../models');
const { subtypeToAxis } = require('./roleTrackMapper');

// The set of valid drill subtypes (must stay in sync with roleTrackMapper)
const VALID_SUBTYPES = new Set(['prompt', 'verify', 'decompose', 'refactor']);

/**
 * Returns the EMA alpha for the given attempt_count.
 *   α = 0.3  when attempt_count < 5  (fast learning early)
 *   α = 0.15 when attempt_count >= 5 (smoothing once we have data)
 */
function emaAlpha(attemptCount) {
  return attemptCount < 5 ? 0.3 : 0.15;
}

/**
 * Clamps `value` to the closed interval [min, max].
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Apply a mastery delta to the user's MetaSkillMastery document.
 *
 * @param {Object} params
 * @param {string|ObjectId} params.user_id       — required
 * @param {string}          params.role_track    — required ('swe' | 'ds' | 'ai_eng')
 * @param {string}          params.drill_subtype — required ('prompt' | 'verify' | 'decompose' | 'refactor')
 * @param {number}          params.score         — required, must be in [0, 100]
 *
 * @returns {Promise<Object>} The updated mastery doc (plain object via toObject())
 */
async function applyMasteryDelta({ user_id, role_track, drill_subtype, score }) {
  // ── Input validation ────────────────────────────────────────────────────────
  if (!user_id) throw new Error('user_id required');
  if (!role_track) throw new Error('role_track required');
  if (!drill_subtype) throw new Error('drill_subtype required');
  if (typeof score !== 'number' || score < 0 || score > 100) {
    throw new Error(`score must be a number in [0, 100]; got ${score}`);
  }

  // Explicit allow-list check so unknown subtypes throw (subtypeToAxis silently
  // defaults unknowns to 'prompting', which would be wrong here)
  if (!VALID_SUBTYPES.has(drill_subtype)) {
    throw new Error(`unknown drill_subtype: ${drill_subtype}`);
  }

  const axis = subtypeToAxis(drill_subtype);

  // ── Find or create the mastery document ────────────────────────────────────
  let mastery = await MetaSkillMastery.findOne({ user_id, role_track });

  if (!mastery) {
    mastery = new MetaSkillMastery({
      user_id,
      role_track,
      axes: { prompting: 0, verification: 0, decomposition: 0, refactoring: 0 },
      confidence: 0,
      attempt_count: 0,
    });
  }

  // ── EMA blend ──────────────────────────────────────────────────────────────
  const alpha = emaAlpha(mastery.attempt_count);
  const oldValue = mastery.axes[axis] || 0;
  const newValue = clamp(oldValue * (1 - alpha) + score * alpha, 0, 100);

  mastery.axes[axis] = newValue;
  mastery.attempt_count = (mastery.attempt_count || 0) + 1;
  mastery.confidence = Math.min(1, mastery.attempt_count / 10);
  mastery.last_updated = new Date();

  // Tell Mongoose that the nested `axes` object has changed
  mastery.markModified('axes');

  await mastery.save();
  return mastery.toObject();
}

module.exports = { applyMasteryDelta, emaAlpha, clamp };
