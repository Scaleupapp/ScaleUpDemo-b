'use strict';

// Phase A ships drills without the Phase B web IDE. Refactor drills require
// a laptop and the web IDE; until then, mobile selects only from these three
// subtypes. Remove this constant when the Phase B web IDE lands and refactor
// drills become servable.
const PHASE_A_DRILL_SUBTYPES = ['prompt', 'verify', 'decompose'];
const PHASE_A_AXES = ['prompting', 'verification', 'decomposition'];

/**
 * Maps a user's objective → role_track for coding practice.
 *
 * Two kinds of input are accepted for mapObjectiveToRoleTrack:
 *   1. Spec-style category keys (e.g. 'software_engineering', 'data_science')
 *      — used for future flexibility and kept for backward compat with the spec.
 *   2. Real canonicalTopic slugs from UserObjective.canonicalTopic
 *      (e.g. 'software-engineer', 'data-scientist', 'machine-learning-engineer')
 *      — this is what the controller actually passes in production.
 *
 * Returns null if the objective doesn't map to any coding track.
 */
const OBJECTIVE_TO_TRACK = {
  // Spec-style category keys
  software_engineering: 'swe',
  backend: 'swe',
  frontend: 'swe',
  fullstack: 'swe',
  mobile_dev: 'swe',
  devops_sre: 'swe',
  data_science: 'ds',
  data_analyst: 'ds',
  ml_engineer: 'ai_eng',
  ai_engineer: 'ai_eng',

  // Real canonical topic slugs (from canonicalTopics.js / UserObjective.canonicalTopic)
  'software-engineer': 'swe',
  'frontend-engineer': 'swe',
  'backend-engineer': 'swe',
  'mobile-engineer': 'swe',
  'devops-engineer': 'swe',
  'data-engineer': 'swe',
  'data-scientist': 'ds',
  'data-analyst': 'ds',
  'machine-learning-engineer': 'ai_eng',
  'switch-to-tech': 'swe',
  'switch-to-data': 'ds',
  'system-design': 'swe',
  'machine-learning': 'ai_eng',
  'cloud-engineering': 'swe',

  // Variants observed in prod that previously fell through:
  'data-science': 'ds',           // 4 users
  'machine_learning': 'ai_eng',   // underscore variant
  'sde': 'swe',                   // common India abbreviation
  'software-development-engineer': 'swe',
  'swe': 'swe',
  'fullstack-engineer': 'swe',
  'mobile-developer': 'swe',
  'ios-developer': 'swe',
  'android-developer': 'swe',
  'sre': 'swe',
  'ml-engineer': 'ai_eng',
  'ai-engineer': 'ai_eng',
  'mlops-engineer': 'ai_eng',
};

/**
 * Map an objective category or canonicalTopic slug to a role_track.
 * Returns 'swe' | 'ds' | 'ai_eng' | null.
 */
function mapObjectiveToRoleTrack(category) {
  if (!category) return null;
  return OBJECTIVE_TO_TRACK[category] || null;
}

const AXIS_TO_SUBTYPE = {
  prompting: 'prompt',
  verification: 'verify',
  decomposition: 'decompose',
  refactoring: 'refactor',
};

const SUBTYPE_TO_AXIS = {
  prompt: 'prompting',
  verify: 'verification',
  decompose: 'decomposition',
  refactor: 'refactoring',
};

/**
 * Given a MetaSkillMastery document (or null), return the name of the weakest
 * axis among Phase A axes (prompting, verification, decomposition).
 * Refactoring is excluded — it requires the Phase B web IDE.
 * Defaults to 'prompting' when no mastery exists.
 */
function pickWeakestAxis(mastery) {
  if (!mastery || !mastery.axes) return 'prompting';
  const axes = mastery.axes;
  let minName = 'prompting';
  let minVal = axes.prompting;
  for (const k of PHASE_A_AXES) {
    const v = axes[k];
    if (typeof v === 'number' && v < minVal) {
      minVal = v;
      minName = k;
    }
  }
  return minName;
}

/** Map axis name → drill_subtype string. */
function axisToSubtype(axis) {
  return AXIS_TO_SUBTYPE[axis] || 'prompt';
}

/** Map drill_subtype string → axis name. */
function subtypeToAxis(subtype) {
  return SUBTYPE_TO_AXIS[subtype] || 'prompting';
}

module.exports = {
  mapObjectiveToRoleTrack,
  pickWeakestAxis,
  axisToSubtype,
  subtypeToAxis,
  OBJECTIVE_TO_TRACK,
  PHASE_A_DRILL_SUBTYPES,
  PHASE_A_AXES,
};
