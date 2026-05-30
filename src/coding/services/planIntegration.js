'use strict';

/**
 * planIntegration.js — Coding drill candidate for the daily Plan palette.
 *
 * Scenario B: Additive layer. The existing v2 Plan engine (src/routes/v2/plan.js)
 * is NOT modified. Instead, consumers call this module to fetch a drill candidate
 * and merge it into the Plan response.
 *
 * HOW TO CONSUME FROM THE FRONTEND / API WRAPPER
 * -----------------------------------------------
 *  Option 1 — API wrapper (recommended for Phase A):
 *    In src/routes/v2/plan.js GET /today, at the bottom of the happy-path
 *    block, call:
 *
 *      const { getDrillCandidate } = require('../../coding/services/planIntegration');
 *      const drillCandidate = await getDrillCandidate(userId).catch(() => null);
 *      // Append to the response:
 *      data.drillCandidate = drillCandidate;  // null when ineligible
 *
 *    The iOS/Android client reads `data.drillCandidate` and, if non-null,
 *    renders it as an additional card in the "Today" task palette, after the
 *    plan tasks.
 *
 *  Option 2 — thin standalone endpoint:
 *    GET /api/v2/plan/drill-candidate → { success, data: { candidate } }
 *    The client calls this in parallel with GET /today and merges the result.
 *
 * QUOTA (spec §19)
 * ----------------
 *  Free-tier: 1 drill/day. Calibration attempts (is_calibration=true) are
 *  excluded from the count — they don't consume the daily quota.
 */

const { ArtifactBundle, DrillAttempt, DifficultyState, MetaSkillMastery } = require('../models');
const CapstoneSession = require('../models/capstoneSession.model');
const { mapObjectiveToRoleTrack, pickWeakestAxis, axisToSubtype, PHASE_A_DRILL_SUBTYPES } = require('./roleTrackMapper');
const { evaluateCodingEligibility } = require('./codingEligibility');

// Per spec §19: free tier = 1 drill/day.
const DAILY_DRILL_QUOTA = 1;

/**
 * Resolve the role_track for a user by looking up their active primary
 * UserObjective.canonicalTopic. Returns null if no coding objective exists.
 *
 * @param {string|ObjectId} user_id
 * @returns {Promise<string|null>}  e.g. 'swe' | 'ds' | 'ai_eng' | null
 */
async function getUserRoleTrack(user_id) {
  let UserObjective;
  try {
    UserObjective = require('../../models/UserObjective');
  } catch (e) {
    UserObjective = require('../../models/userObjective');
  }
  const obj = await UserObjective.findOne({
    userId: user_id,
    status: 'active',
    isPrimary: true,
  }).lean();
  const eligibility = evaluateCodingEligibility(obj);
  return eligibility.eligible ? eligibility.role_track : null;
}

/**
 * Returns true if the user has already used their daily drill quota today.
 * Calibration attempts (is_calibration=true) are NOT counted.
 *
 * @param {string|ObjectId} user_id
 * @returns {Promise<boolean>}
 */
async function hasUsedDailyQuota(user_id) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const count = await DrillAttempt.countDocuments({
    user_id,
    is_calibration: { $ne: true },
    status: 'graded',                   // only fully graded attempts count; abandoned in-progress don't lock the user out
    submitted_at: { $gte: startOfDay },
  });
  return count >= DAILY_DRILL_QUOTA;
}

/**
 * Gate function: should we offer a drill candidate today?
 *
 * Returns true only when ALL of the following hold:
 *   1. user_id is provided
 *   2. User has an active coding objective that maps to a role_track
 *   3. Daily quota has NOT been used
 *   4. At least one active ArtifactBundle exists for the resolved role_track
 *
 * @param {string|ObjectId} user_id
 * @returns {Promise<boolean>}
 */
async function shouldOfferDrillToday(user_id) {
  if (!user_id) return false;

  const role_track = await getUserRoleTrack(user_id);
  if (!role_track) return false;

  const usedQuota = await hasUsedDailyQuota(user_id);
  if (usedQuota) return false;

  const bundleExists = await ArtifactBundle.exists({
    type: 'drill',
    role_track,
    status: 'active',
    drill_subtype: { $in: PHASE_A_DRILL_SUBTYPES },
  });
  return Boolean(bundleExists);
}

/**
 * Build and return a TaskCandidate for the user's daily drill slot, or null
 * if the user is not eligible (shouldOfferDrillToday returns false).
 *
 * The candidate is shaped so that the Plan route / iOS client can render it as
 * a first-class task card in the "Today" palette, identical in contract to the
 * shapeTask() output in v2/plan.js.
 *
 * @param {string|ObjectId} user_id
 * @returns {Promise<Object|null>}
 */
async function getDrillCandidate(user_id) {
  if (!await shouldOfferDrillToday(user_id)) return null;

  const role_track = await getUserRoleTrack(user_id);

  // Resolve current difficulty (default 'easy' when no history).
  const diffState = await DifficultyState.findOne({ user_id, role_track }).lean();
  const difficulty = diffState ? diffState.current_difficulty : 'easy';

  // Resolve weakest axis → preferred drill_subtype.
  const mastery = await MetaSkillMastery.findOne({ user_id, role_track }).lean();
  const weakestAxis = pickWeakestAxis(mastery);
  const drill_subtype = axisToSubtype(weakestAxis);

  // Try to find a bundle matching both the preferred subtype and difficulty.
  let bundle = await ArtifactBundle.findOne({
    type: 'drill',
    role_track,
    difficulty,
    drill_subtype,
    status: 'active',
  }).sort({ createdAt: -1 }).lean();

  if (!bundle) {
    // Fallback: any active Phase A drill in this role_track + difficulty.
    bundle = await ArtifactBundle.findOne({
      type: 'drill',
      role_track,
      difficulty,
      drill_subtype: { $in: PHASE_A_DRILL_SUBTYPES },
      status: 'active',
    }).sort({ createdAt: -1 }).lean();
  }

  if (!bundle) return null;

  return buildCandidate(bundle, role_track);
}

/**
 * Shape a raw ArtifactBundle document into the TaskCandidate object surfaced
 * in the Plan palette.
 *
 * @param {Object} bundle  - lean ArtifactBundle doc
 * @param {string} role_track
 * @returns {Object}
 */
function buildCandidate(bundle, role_track) {
  return {
    type: 'coding_drill',
    bundle_id: bundle._id,
    role_track,
    drill_subtype: bundle.drill_subtype,
    difficulty: bundle.difficulty,
    title: `Coding Drill — ${prettySubtype(bundle.drill_subtype)}`,
    brief_preview: bundle.brief.length > 120
      ? bundle.brief.slice(0, 120) + '…'
      : bundle.brief,
    estimated_minutes: bundle.time_budget_minutes,
    cta_url: `/api/coding/drills/${bundle._id}/start`,
  };
}

/**
 * Human-readable drill subtype label.
 * @param {string} s - drill_subtype enum value
 * @returns {string}
 */
function prettySubtype(s) {
  const MAP = {
    prompt: 'Prompt',
    verify: 'Bug Hunt',
    decompose: 'Decompose',
    refactor: 'Refactor with AI',
  };
  return MAP[s] || s;
}

// ---------------------------------------------------------------------------
// Capstone milestone integration (Phase B)
// ---------------------------------------------------------------------------
//
// Cadence: 1 capstone every 7 days per user. The candidate appears in
// the Plan response as `data.capstoneMilestone` when:
//   1. user has a coding objective + role_track
//   2. no graded capstone in the trailing 7 days
//   3. no in-progress capstone session (don't double-offer)
//   4. at least one active capstone bundle exists for the role_track
//
// Difficulty selection — promote one level above the user's drill
// difficulty so capstones stay meaningfully harder than daily drills.

const CAPSTONE_INTERVAL_DAYS = 7;

const DIFFICULTY_ORDER = ['easy', 'medium', 'hard', 'staff_plus'];

function nextDifficulty(current) {
  const i = DIFFICULTY_ORDER.indexOf(current);
  if (i < 0) return 'medium';
  return DIFFICULTY_ORDER[Math.min(i + 1, DIFFICULTY_ORDER.length - 1)];
}

async function hasRecentCapstone(user_id) {
  const since = new Date(Date.now() - CAPSTONE_INTERVAL_DAYS * 24 * 60 * 60 * 1000);
  const recent = await CapstoneSession.exists({
    user_id,
    status: 'graded',
    graded_at: { $gte: since },
  });
  return Boolean(recent);
}

async function hasActiveCapstone(user_id) {
  const active = await CapstoneSession.exists({
    user_id,
    status: { $in: ['provisioning', 'ready', 'in_progress', 'paused', 'submitted', 'evaluating'] },
  });
  return Boolean(active);
}

/**
 * Returns a capstone milestone candidate for the Plan palette, or null
 * when the user already has one in flight / shouldn't be offered one yet.
 *
 * @param {string|ObjectId} user_id
 * @returns {Promise<Object|null>}
 */
async function getCapstoneMilestone(user_id) {
  if (!user_id) return null;

  const role_track = await getUserRoleTrack(user_id);
  if (!role_track) return null;

  if (await hasActiveCapstone(user_id)) return null;
  if (await hasRecentCapstone(user_id)) return null;

  // If the learner is in an auto-assembled track, the milestone IS the track's
  // current active step — prefer it over a random capstone so the surfaced
  // "next capstone" follows the sequence.
  try {
    const trackService = require('./capstoneTrackService');
    const stepBundleId = await trackService.getActiveStepBundleId(user_id);
    if (stepBundleId) {
      const stepBundle = await ArtifactBundle.findById(stepBundleId).lean();
      if (stepBundle && stepBundle.status === 'active') {
        return {
          type: 'capstone_milestone',
          bundle_id: stepBundle._id,
          role_track,
          difficulty: stepBundle.difficulty,
          title: `Capstone — ${prettyDifficulty(stepBundle.difficulty)}`,
          brief_preview: (stepBundle.brief || '').slice(0, 200),
          estimated_minutes: stepBundle.time_budget_minutes,
          cadence: 'track',
          cta_url: `/api/coding/capstones/${stepBundle._id}/start`,
        };
      }
    }
  } catch (_) { /* fall through to single-capstone selection */ }

  // Pick difficulty: one notch above current drill difficulty.
  const diffState = await DifficultyState.findOne({ user_id, role_track }).lean();
  const baseDiff = diffState ? diffState.current_difficulty : 'easy';
  const targetDiff = nextDifficulty(baseDiff);

  // Try preferred difficulty first; fall back to anything available.
  let bundle = await ArtifactBundle.findOne({
    type: 'capstone',
    role_track,
    difficulty: targetDiff,
    status: 'active',
  }).sort({ createdAt: -1 }).lean();

  if (!bundle) {
    bundle = await ArtifactBundle.findOne({
      type: 'capstone',
      role_track,
      status: 'active',
    }).sort({ createdAt: -1 }).lean();
  }

  if (!bundle) return null;

  return {
    type: 'capstone_milestone',
    bundle_id: bundle._id,
    role_track,
    difficulty: bundle.difficulty,
    title: `Capstone — ${prettyDifficulty(bundle.difficulty)}`,
    brief_preview: bundle.brief.length > 200
      ? bundle.brief.slice(0, 200) + '…'
      : bundle.brief,
    estimated_minutes: bundle.time_budget_minutes,
    cadence: 'weekly',
    cta_url: `/api/coding/capstones/${bundle._id}/start`,
  };
}

function prettyDifficulty(d) {
  return { easy: 'Easy', medium: 'Medium', hard: 'Hard', staff_plus: 'Staff+' }[d] || d;
}

module.exports = {
  shouldOfferDrillToday,
  getDrillCandidate,
  hasUsedDailyQuota,
  getUserRoleTrack,
  buildCandidate,
  prettySubtype,
  DAILY_DRILL_QUOTA,
  getCapstoneMilestone,
  CAPSTONE_INTERVAL_DAYS,
};
