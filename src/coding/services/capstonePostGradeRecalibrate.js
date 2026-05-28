'use strict';

/**
 * capstonePostGradeRecalibrate.js
 *
 * Bridges a graded capstone into the same learning-loop machinery the daily
 * drills already use:
 *   1. applyMasteryDelta for each capstone dimension that maps to a drill
 *      axis (prompt / verify / decompose / refactor)
 *   2. recordRecommendation so DifficultyState gets a fresh next-step suggestion
 *
 * Previously this was a real gap — capstones produced scores but never
 * touched MetaSkillMastery or DifficultyState, which is why /capstones/summary
 * kept showing the same "current_difficulty: easy" forever and the Compass
 * tab never reflected progress.
 *
 * Mapping (capstone 0-10 dimension → drill 0-100 score):
 *
 *   capstone.ai_pair_effectiveness   →  drill axis "prompt"     × 10
 *   capstone.verification_discipline →  drill axis "verify"     × 10
 *   capstone.decomposition           →  drill axis "decompose"  × 10
 *   capstone.code_quality            →  drill axis "refactor"   × 10
 *
 *   capstone.correctness + reflection_quality don't have a direct drill
 *   axis — they feed the overall recalibration signal only.
 *
 * Best-effort: failures are logged but don't propagate so a recalibration
 * blip never blocks the graded transition.
 */

const CapstoneSession = require('../models/capstoneSession.model');
const ArtifactBundle = require('../models/artifactBundle.model');

/** Map capstone dimension keys to drill axis names. */
const DIMENSION_TO_AXIS = Object.freeze({
  ai_pair_effectiveness: 'prompt',
  verification_discipline: 'verify',
  decomposition: 'decompose',
  code_quality: 'refactor',
});

async function applyPostGradeRecalibrationForCapstone(sessionId) {
  const session = await CapstoneSession.findById(sessionId).lean();
  if (!session || session.status !== 'graded' || !session.result) return { applied: false };

  const bundle = await ArtifactBundle.findById(session.bundle_id).lean();
  if (!bundle) return { applied: false };

  const dims = session.result.dimension_scores || {};
  const { applyMasteryDelta } = require('./masteryDelta');

  const masteryResults = {};
  for (const [dimKey, axisName] of Object.entries(DIMENSION_TO_AXIS)) {
    const raw = dims[dimKey];
    if (typeof raw !== 'number') continue;
    const score100 = Math.max(0, Math.min(100, Math.round(raw * 10)));
    try {
      const updated = await applyMasteryDelta({
        user_id: session.user_id,
        role_track: bundle.role_track,
        drill_subtype: axisName,
        score: score100,
      });
      masteryResults[axisName] = updated?.[axisName]?.level ?? null;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[capstonePostGradeRecalibrate] mastery delta failed for axis=${axisName}:`, err.message);
    }
  }

  // Difficulty recalibration: feed the capstone's overall_score into a
  // synthetic DifficultyState bump. Capstones don't have a DrillAttempt
  // doc to feed recordRecommendation, so we apply the bump directly
  // based on score thresholds (matching the drill recalibrator's rules).
  let difficulty = null;
  try {
    const DifficultyState = require('../models/difficultyState.model');
    const overall = session.result.overall_score || 0;
    const ORDER = ['easy', 'medium', 'hard', 'staff_plus'];
    const ds = await DifficultyState.findOne({
      user_id: session.user_id,
      role_track: bundle.role_track,
    });
    const currentIdx = ds ? ORDER.indexOf(ds.current_difficulty) : ORDER.indexOf(bundle.difficulty);
    const safeIdx = Math.max(0, currentIdx >= 0 ? currentIdx : ORDER.indexOf(bundle.difficulty));
    let nextIdx = safeIdx;
    if (overall >= 80) nextIdx = Math.min(ORDER.length - 1, safeIdx + 1);
    else if (overall < 40) nextIdx = Math.max(0, safeIdx - 1);

    if (ds && ORDER[nextIdx] !== ds.current_difficulty) {
      ds.current_difficulty = ORDER[nextIdx];
      ds.last_recalibrated_at = new Date();
      await ds.save();
      difficulty = { from: ORDER[safeIdx], to: ORDER[nextIdx] };
    } else if (!ds) {
      await DifficultyState.create({
        user_id: session.user_id,
        role_track: bundle.role_track,
        current_difficulty: ORDER[nextIdx],
        last_recalibrated_at: new Date(),
      });
      difficulty = { from: null, to: ORDER[nextIdx] };
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[capstonePostGradeRecalibrate] difficulty bump failed:', err.message);
  }

  return { applied: true, masteryResults, difficulty };
}

module.exports = {
  applyPostGradeRecalibrationForCapstone,
  DIMENSION_TO_AXIS,
};
