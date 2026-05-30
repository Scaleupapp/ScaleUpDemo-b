'use strict';

/**
 * capstoneSummary.js — read-only aggregates surfaced on the Compass tab.
 *
 * Powers two surfaces:
 *   1. The "Coding" entry-point card on the mobile Compass tab — shows
 *      last-N capstone scores + current mastery snapshot at a glance.
 *   2. The Compass chat ("how am I doing on coding?") — feeds the LLM a
 *      structured context so it can give a grounded answer.
 *
 * Spec §11.4 (Compass surface for coding history) + §8.5 (mastery export
 * to Compass).
 */

const CapstoneSession = require('../models/capstoneSession.model');
const DifficultyState = require('../models/difficultyState.model');
const MetaSkillMastery = require('../models/metaSkillMastery.model');
const ArtifactBundle = require('../models/artifactBundle.model');
const { mapObjectiveToRoleTrack } = require('./roleTrackMapper');
const { evaluateCodingEligibility } = require('./codingEligibility');

const RECENT_LIMIT = 5;

/**
 * Build a complete coding-status snapshot for one learner.
 *
 * @param {string|ObjectId} userId
 * @returns {Promise<{
 *   eligible: boolean,
 *   role_track: 'swe'|'ds'|'ai_eng'|null,
 *   current_difficulty: string|null,
 *   mastery: { prompting, verification, decomposition, refactoring } | null,
 *   recent_capstones: Array<{
 *     session_id, bundle_id, bundle_brief_preview, difficulty,
 *     overall_score, graded_at, integrity_confidence, dimension_scores
 *   }>,
 *   in_progress: { session_id, bundle_id, status, expires_at } | null,
 *   next_available_at: Date | null,
 *   summary_line: string
 * }>}
 */
async function buildSummary(userId) {
  if (!userId) {
    return blankSummary();
  }

  const roleTrack = await getRoleTrack(userId);
  if (!roleTrack) {
    return blankSummary();
  }

  // Pull current calibration + mastery in parallel.
  const [diffState, mastery, inProgressSession, recent] = await Promise.all([
    DifficultyState.findOne({ user_id: userId, role_track: roleTrack }).lean(),
    MetaSkillMastery.findOne({ user_id: userId, role_track: roleTrack }).lean(),
    CapstoneSession.findOne({
      user_id: userId,
      status: { $in: ['provisioning', 'ready', 'in_progress', 'paused', 'submitted', 'evaluating'] },
    }).lean(),
    CapstoneSession.find({
      user_id: userId,
      status: 'graded',
    })
      .sort({ graded_at: -1 })
      .limit(RECENT_LIMIT)
      .populate('bundle_id', 'brief difficulty drill_subtype role_track')
      .lean(),
  ]);

  const recentShaped = recent.map((s) => ({
    session_id: String(s._id),
    bundle_id: s.bundle_id?._id ? String(s.bundle_id._id) : null,
    bundle_brief_preview: shortenBrief(s.bundle_id?.brief),
    difficulty: s.bundle_id?.difficulty ?? null,
    overall_score: s.result?.overall_score ?? null,
    graded_at: s.graded_at,
    integrity_confidence: s.result?.integrity_confidence ?? null,
    dimension_scores: s.result?.dimension_scores ?? null,
  }));

  // Cadence: 7 days since last graded capstone. If user has one in last 7 days, gate them.
  const nextAvailableAt = computeNextAvailableAt(recentShaped);

  return {
    eligible: true,
    role_track: roleTrack,
    current_difficulty: diffState?.current_difficulty ?? 'easy',
    mastery: shapeMastery(mastery),
    recent_capstones: recentShaped,
    in_progress: inProgressSession
      ? {
          session_id: String(inProgressSession._id),
          bundle_id: String(inProgressSession.bundle_id),
          status: inProgressSession.status,
          // A not-yet-started session (scheduled/provisioning/ready) has no
          // wall-clock deadline yet — `expires_at` is only stamped when the
          // session actually starts. Emit an explicit null (never undefined)
          // so the field is always present in the contract.
          expires_at: inProgressSession.expires_at || null,
        }
      : null,
    next_available_at: nextAvailableAt,
    summary_line: buildSummaryLine({
      recentShaped,
      diffState,
      inProgressSession,
      nextAvailableAt,
    }),
  };
}

function blankSummary() {
  return {
    eligible: false,
    role_track: null,
    current_difficulty: null,
    mastery: null,
    recent_capstones: [],
    in_progress: null,
    next_available_at: null,
    summary_line: 'Coding capstones are available once you set an objective in SWE, Data Science, or AI/ML engineering.',
  };
}

async function getRoleTrack(userId) {
  let UserObjective;
  try {
    UserObjective = require('../../models/UserObjective');
  } catch (e) {
    UserObjective = require('../../models/userObjective');
  }
  const obj = await UserObjective.findOne({
    userId,
    status: 'active',
    isPrimary: true,
  }).lean();
  const eligibility = evaluateCodingEligibility(obj);
  return eligibility.eligible ? eligibility.role_track : null;
}

function shapeMastery(doc) {
  if (!doc) return null;
  // The model stores per-axis levels 0..10; the frontend wants a flat 4-key object.
  return {
    prompting: round1(doc.prompting?.level ?? 0),
    verification: round1(doc.verification?.level ?? 0),
    decomposition: round1(doc.decomposition?.level ?? 0),
    refactoring: round1(doc.refactoring?.level ?? 0),
  };
}

function round1(n) {
  return Math.round(Number(n || 0) * 10) / 10;
}

function shortenBrief(brief) {
  if (!brief) return '';
  const oneLine = brief.replace(/\s+/g, ' ').trim();
  return oneLine.length > 140 ? oneLine.slice(0, 140) + '…' : oneLine;
}

const CADENCE_DAYS = 7;

function computeNextAvailableAt(recent) {
  if (recent.length === 0) return new Date(); // available now
  const lastGradedAt = recent[0].graded_at;
  if (!lastGradedAt) return new Date();
  return new Date(new Date(lastGradedAt).getTime() + CADENCE_DAYS * 24 * 60 * 60 * 1000);
}

function buildSummaryLine({ recentShaped, diffState, inProgressSession, nextAvailableAt }) {
  if (inProgressSession) {
    return 'You have a capstone in progress — finish it on your laptop.';
  }
  if (recentShaped.length === 0) {
    return 'No capstones yet. Try your first one to see how you stack up.';
  }
  const last = recentShaped[0];
  const score = Number(last.overall_score ?? 0).toFixed(1);
  const diff = diffState?.current_difficulty ?? 'easy';
  const now = Date.now();
  if (nextAvailableAt && nextAvailableAt.getTime() > now) {
    const days = Math.max(1, Math.ceil((nextAvailableAt.getTime() - now) / (24 * 60 * 60 * 1000)));
    return `Last capstone: ${score}/10. Next one available in ${days} day${days > 1 ? 's' : ''}. Current level: ${diff}.`;
  }
  return `Last capstone: ${score}/10. A new one is ready when you are. Current level: ${diff}.`;
}

module.exports = { buildSummary, RECENT_LIMIT, CADENCE_DAYS };
