'use strict';

/**
 * targetService — Robust Rule A: an objective-aware, ambition-anchored readiness
 * TARGET (replaces the hardcoded flat 80).
 *
 * Deterministic (no LLM call): derives the target from the objective archetype,
 * the ambition signals in `specifics` (named target company / exam), and — when
 * available — the per-competency framework already produced by
 * objectiveAnalysisService (weight + category). Falls back gracefully to a
 * sensible number when there's no analysis yet.
 *
 * `getEffectiveTarget` is the single gate: it returns the personalized target
 * ONLY when FEATURE_OBJECTIVE_TARGET is on; otherwise it returns 80 so every
 * downstream consumer behaves exactly as today.
 */

const featureFlags = require('../../config/featureFlags');
const { MIN_OUTCOMES_PER_ARCHETYPE } = require('./calibrationService');

const FLOOR = 55;
const CEILING = 95;
const LEGACY_TARGET = 80;

// How ambitious each objective archetype is, as a +/- modifier on the base.
const ARCHETYPE_AMBITION = {
  exam_preparation: 8,
  interview_preparation: 6,
  academic_excellence: 3,
  career_switch: 2,
  upskilling: 0,
  networking: -12,
  casual_learning: -18,
};

// Target score a competency should reach, by its importance category.
const CATEGORY_TARGET_SCORE = {
  core: 80,
  advanced: 78,
  soft_skill: 62,
};
const DEFAULT_CATEGORY_SCORE = 72;

function clampTarget(n) {
  return Math.max(FLOOR, Math.min(CEILING, Math.round(n)));
}

/** Ambition modifier from archetype + whether a concrete target company/exam is named. */
function ambitionModifier(objective) {
  const type = objective?.objectiveType;
  let mod = ARCHETYPE_AMBITION[type] ?? 0;
  const s = objective?.specifics || {};
  if (s.targetCompany && String(s.targetCompany).trim()) mod += 4; // aiming at a named company = higher bar
  if (s.examName && String(s.examName).trim() && type === 'exam_preparation') mod += 2;
  return mod;
}

/**
 * Compute the personalized target (0..100, clamped to [55,95]).
 * Pure — safe to call on every request.
 * @param {object} objective  UserObjective (lean or doc), may include analysis.competencies
 * @returns {number}
 */
function computeTarget(objective) {
  const mod = ambitionModifier(objective);
  const comps = objective?.analysis?.competencies;

  if (!Array.isArray(comps) || comps.length === 0) {
    // No framework yet — anchor on a neutral base + ambition.
    return clampTarget(78 + mod);
  }

  let wSum = 0;
  let sSum = 0;
  for (const c of comps) {
    const w = typeof c.weight === 'number' && c.weight > 0 ? c.weight : 5;
    const base = CATEGORY_TARGET_SCORE[c.category] ?? DEFAULT_CATEGORY_SCORE;
    wSum += w;
    sSum += base * w;
  }
  const competencyTarget = wSum > 0 ? sSum / wSum : 78;
  return clampTarget(competencyTarget + mod);
}

/**
 * The value downstream consumers should use. Flag OFF => 80 (today's behavior).
 * Flag ON => the objective's persisted target, else a freshly computed one.
 * @param {object} objective
 * @returns {number}
 */
function getEffectiveTarget(objective) {
  if (!featureFlags.objectiveTarget) return LEGACY_TARGET;
  // Phase 4B — evidence-based target when calibration is on AND the archetype has
  // a sufficient model. Read via a sync process cache. No-op when flag off / no model.
  if (featureFlags.outcomeCalibratedTarget && objective) {
    try {
      const { setKeyFor } = require('./archetypeKey');
      const m = require('./calibrationCache').get(setKeyFor(objective.objectiveType));
      if (m && typeof m.target === 'number' && (m.sampleCount || 0) >= MIN_OUTCOMES_PER_ARCHETYPE) return m.target;
    } catch (e) { /* fall through to heuristic */ }
  }
  if (objective && typeof objective.target === 'number' && objective.target > 0) return objective.target;
  return computeTarget(objective);
}

/**
 * Readiness bands around a target, for the UI ("Competitive / Strong / Exceptional").
 * @param {number} target
 * @returns {{competitive:number, strong:number, exceptional:number}}
 */
function targetBands(target) {
  const strong = clampTarget(target);
  return {
    competitive: Math.max(40, strong - 12),
    strong,
    exceptional: Math.min(98, strong + 8),
  };
}

/**
 * Persist the computed target on the objective, appending to targetHistory when
 * it changes meaningfully (>=2 points) or is first set. Best-effort: never
 * throws. Only does work when the flag is on (so shadow stays read-only).
 * @param {object} objectiveDoc  a Mongoose UserObjective document (not lean)
 * @param {string} [reason]
 * @returns {Promise<number>} the effective target
 */
async function ensureTarget(objectiveDoc, reason = 'recompute') {
  const effective = getEffectiveTarget(objectiveDoc);
  if (!featureFlags.objectiveTarget || !objectiveDoc || typeof objectiveDoc.save !== 'function') {
    return effective;
  }
  try {
    const fresh = computeTarget(objectiveDoc);
    const prev = typeof objectiveDoc.target === 'number' ? objectiveDoc.target : null;
    if (prev === null || Math.abs(fresh - prev) >= 2) {
      objectiveDoc.target = fresh;
      objectiveDoc.targetHistory = objectiveDoc.targetHistory || [];
      objectiveDoc.targetHistory.push({ value: fresh, reason, at: new Date() });
      await objectiveDoc.save();
      return fresh;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[targetService.ensureTarget] skipped:', err.message);
  }
  return effective;
}

module.exports = {
  computeTarget,
  getEffectiveTarget,
  ambitionModifier,
  targetBands,
  ensureTarget,
  LEGACY_TARGET,
};
