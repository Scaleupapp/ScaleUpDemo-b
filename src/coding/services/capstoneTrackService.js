'use strict';

/**
 * capstoneTrackService — auto-assembled capstone tracks.
 *
 * A track is a per-learner, ordered sequence of capstones that ramps in
 * difficulty (easy → medium → hard). We assemble it at enrollment from the
 * learner's role_track, skipping capstones they've already graded, and freeze
 * the sequence onto a TrackEnrollment so progress is stable.
 *
 * Unlock-on-grade: only step 0 starts active; each later step unlocks when the
 * prior step's capstone reaches `graded`. advanceOnGrade() is called from the
 * post-grade chain.
 */

const TrackEnrollment = require('../models/trackEnrollment.model');
const ArtifactBundle = require('../models/artifactBundle.model');
const CapstoneSession = require('../models/capstoneSession.model');

const TRACK_LENGTH = 5;
const DIFF_ORDER = ['easy', 'medium', 'hard'];

const TITLE_BY_TRACK = {
  swe: 'Software Engineering interview prep',
  ds: 'Data Science interview prep',
  ai_eng: 'AI / ML engineering interview prep',
};

/** Active enrollment for a user, or null. */
async function getActiveEnrollment(userId) {
  return TrackEnrollment.findOne({ user_id: userId, is_active: true }).lean();
}

/**
 * Auto-assemble + enroll. Idempotent-ish: if an active enrollment already
 * exists, returns it untouched. Returns null if the learner has no role_track
 * or there aren't enough bundles to build a track.
 *
 * @param {string} userId
 * @param {string} roleTrack  resolved by the caller (controller)
 */
async function enrollAutoTrack(userId, roleTrack) {
  if (!roleTrack) return null;

  const existing = await TrackEnrollment.findOne({ user_id: userId, is_active: true });
  if (existing) return existing.toObject();

  // Skip bundles the learner already graded.
  const gradedSessions = await CapstoneSession.find({
    user_id: userId,
    status: 'graded',
  }).select('bundle_id').lean();
  const gradedBundleIds = new Set(gradedSessions.map((s) => String(s.bundle_id)));

  // Pull active capstones for the role-track, grouped by difficulty.
  const bundles = await ArtifactBundle.find({
    type: 'capstone',
    role_track: roleTrack,
    status: 'active',
  })
    .select('_id difficulty brief createdAt')
    .sort({ createdAt: 1 })
    .lean();

  const available = bundles.filter((b) => !gradedBundleIds.has(String(b._id)));
  if (available.length === 0) return null;

  // Ramp: take from easy → medium → hard, round-robin, until we have TRACK_LENGTH.
  const byDiff = { easy: [], medium: [], hard: [] };
  for (const b of available) {
    if (byDiff[b.difficulty]) byDiff[b.difficulty].push(b);
  }
  const ordered = [];
  // First pass: one ascending sweep to guarantee a ramp shape.
  for (const d of DIFF_ORDER) {
    if (byDiff[d].length) ordered.push(byDiff[d].shift());
    if (ordered.length >= TRACK_LENGTH) break;
  }
  // Fill remaining slots, still ascending, draining each difficulty in turn.
  let progressed = true;
  while (ordered.length < TRACK_LENGTH && progressed) {
    progressed = false;
    for (const d of DIFF_ORDER) {
      if (ordered.length >= TRACK_LENGTH) break;
      if (byDiff[d].length) {
        ordered.push(byDiff[d].shift());
        progressed = true;
      }
    }
  }

  if (ordered.length < 2) return null; // a 1-step "track" isn't a track

  const steps = ordered.map((b, i) => ({
    bundle_id: b._id,
    difficulty: b.difficulty,
    brief_preview: shorten(b.brief),
    status: i === 0 ? 'active' : 'locked',
    session_id: null,
    overall_score: null,
    completed_at: null,
  }));

  const enrollment = await TrackEnrollment.create({
    user_id: userId,
    role_track: roleTrack,
    title: TITLE_BY_TRACK[roleTrack] || 'Capstone track',
    steps,
    current_step: 0,
    is_active: true,
  });
  return enrollment.toObject();
}

/**
 * Called after a capstone is graded. If the graded bundle is the active step
 * of the learner's track, mark it completed, unlock the next step, and advance
 * current_step. Completes the track when the last step is done.
 *
 * Best-effort: never throws (caller wraps in try/catch).
 *
 * @param {string} userId
 * @param {string|ObjectId} bundleId
 * @param {string|ObjectId} sessionId
 * @param {number} overallScore
 */
async function advanceOnGrade(userId, bundleId, sessionId, overallScore) {
  const enrollment = await TrackEnrollment.findOne({ user_id: userId, is_active: true });
  if (!enrollment) return { advanced: false };

  const idx = enrollment.steps.findIndex(
    (s) => String(s.bundle_id) === String(bundleId) && s.status === 'active'
  );
  if (idx === -1) return { advanced: false };

  enrollment.steps[idx].status = 'completed';
  enrollment.steps[idx].session_id = sessionId;
  enrollment.steps[idx].overall_score = typeof overallScore === 'number' ? overallScore : null;
  enrollment.steps[idx].completed_at = new Date();

  if (idx + 1 < enrollment.steps.length) {
    enrollment.steps[idx + 1].status = 'active';
    enrollment.current_step = idx + 1;
  } else {
    enrollment.current_step = enrollment.steps.length;
    enrollment.is_active = false;
    enrollment.completed_at = new Date();
  }

  await enrollment.save();
  return { advanced: true, completed: !enrollment.is_active, next_step: enrollment.current_step };
}

/**
 * The active step's bundle_id for a learner's track, or null. Used by
 * planIntegration to prefer the track's next capstone over a random one.
 */
async function getActiveStepBundleId(userId) {
  const enrollment = await TrackEnrollment.findOne({ user_id: userId, is_active: true }).lean();
  if (!enrollment) return null;
  const step = enrollment.steps.find((s) => s.status === 'active');
  return step ? String(step.bundle_id) : null;
}

function shorten(brief) {
  if (!brief) return '';
  const oneLine = brief.replace(/\s+/g, ' ').trim();
  return oneLine.length > 120 ? oneLine.slice(0, 120) + '…' : oneLine;
}

module.exports = {
  getActiveEnrollment,
  enrollAutoTrack,
  advanceOnGrade,
  getActiveStepBundleId,
  TRACK_LENGTH,
};
