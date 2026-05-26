'use strict';

/**
 * readinessUpdater.js
 *
 * Provides the meta-skill component for the Readiness Score.
 *
 * INTEGRATION SCENARIO: B (documented — existing Readiness computation NOT modified)
 *
 * After exploring the codebase, the existing Readiness Score is computed in two
 * places, neither of which has a clean component-addition hook:
 *
 *   1. src/services/dashboardService.js (line 58):
 *      Monolithic inline formula:
 *        readinessScore = Math.round(knowledgeScore * 0.4 + journeyScore * 0.3 + consistencyScore * 0.3)
 *      No component array, no extension point.
 *
 *   2. src/routes/v2/you.js (line 58-62):
 *      A priority waterfall that reads pre-persisted scores from the DB:
 *        plan?.readinessScore ?? journey?.readinessScore ?? computeReadinessFromKnowledge(knowledge)
 *      Modifying this would require either (a) persisting a new combined score
 *      or (b) making this route async-heavier for every You-tab load.
 *
 * Chosen approach (Scenario B):
 *   - This module is a PURE ADDITIVE hook.
 *   - `getMetaSkillComponent` computes the meta-skill contribution (value × weight).
 *   - The weight ramps linearly from 0 → 0.10 as attempt_count goes from 5 → 10.
 *   - Below 5 attempts the weight is 0 (backfill-safe: no sudden score change for existing users).
 *   - Callers (e.g. a drill-grade-complete webhook/worker) can add the `contribution`
 *     to the base Readiness Score and persist it, without touching the existing formulas.
 *
 * Phase A follow-up: wire this into the drill-grade-complete flow so that after
 * each graded drill the persisted plan.readinessScore (or a new coding_readiness
 * field) is updated with the meta-skill contribution included.
 */

const { MetaSkillMastery } = require('../models');

const TARGET_WEIGHT = 0.10;
const MIN_ATTEMPTS_FOR_RAMP = 5;
const FULL_RAMP_ATTEMPTS = 10;

/**
 * Pure function: returns the weight [0, TARGET_WEIGHT] for the meta-skill
 * component given the user's total drill attempt count.
 *
 * Weight is 0 below MIN_ATTEMPTS_FOR_RAMP, then ramps linearly to TARGET_WEIGHT
 * at FULL_RAMP_ATTEMPTS, and is capped there for higher counts.
 *
 * @param {number} attemptCount
 * @returns {number}
 */
function getMetaSkillWeight(attemptCount) {
  if (attemptCount < MIN_ATTEMPTS_FOR_RAMP) return 0;
  if (attemptCount >= FULL_RAMP_ATTEMPTS) return TARGET_WEIGHT;
  // Linear ramp from MIN_ATTEMPTS_FOR_RAMP → FULL_RAMP_ATTEMPTS
  const progress = (attemptCount - MIN_ATTEMPTS_FOR_RAMP) / (FULL_RAMP_ATTEMPTS - MIN_ATTEMPTS_FOR_RAMP);
  return TARGET_WEIGHT * progress;
}

/**
 * Pure function: returns the average of the 4 meta-skill axes (0-100).
 *
 * @param {{ prompting: number, verification: number, decomposition: number, refactoring: number } | null} axes
 * @returns {number}
 */
function metaSkillValue(axes) {
  if (!axes) return 0;
  return (axes.prompting + axes.verification + axes.decomposition + axes.refactoring) / 4;
}

/**
 * Async: fetches the MetaSkillMastery document for the given user/track and
 * computes the component's value, weight, and contribution.
 *
 * Returns { value, weight, contribution, attempt_count } where:
 *   - value        = average of the 4 axes (0-100)
 *   - weight       = ramped weight (0 → 0.10)
 *   - contribution = value × weight  (the additive delta to apply to the base score)
 *   - attempt_count = raw attempt count from the mastery doc (0 if no doc)
 *
 * When no mastery doc exists, or when attempt_count < MIN_ATTEMPTS_FOR_RAMP,
 * contribution is 0 — safe to add to any existing score without changing it.
 *
 * @param {{ user_id: string, role_track: string }} param
 * @returns {Promise<{ value: number, weight: number, contribution: number, attempt_count: number }>}
 */
async function getMetaSkillComponent({ user_id, role_track }) {
  const mastery = await MetaSkillMastery.findOne({ user_id, role_track }).lean();
  if (!mastery) {
    return { value: 0, weight: 0, contribution: 0, attempt_count: 0 };
  }
  const value = metaSkillValue(mastery.axes);
  const weight = getMetaSkillWeight(mastery.attempt_count);
  const contribution = value * weight;
  return { value, weight, contribution, attempt_count: mastery.attempt_count };
}

module.exports = {
  getMetaSkillComponent,
  getMetaSkillWeight,
  metaSkillValue,
  TARGET_WEIGHT,
  MIN_ATTEMPTS_FOR_RAMP,
  FULL_RAMP_ATTEMPTS,
};
