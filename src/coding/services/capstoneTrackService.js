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

  try {
    const enrollment = await TrackEnrollment.create({
      user_id: userId,
      role_track: roleTrack,
      title: TITLE_BY_TRACK[roleTrack] || 'Capstone track',
      steps,
      current_step: 0,
      is_active: true,
    });
    return enrollment.toObject();
  } catch (err) {
    // Lost a create race (partial-unique index on {user_id, is_active:true}
    // rejected the duplicate). Return whoever won — never two active tracks.
    if (err && err.code === 11000) {
      return TrackEnrollment.findOne({ user_id: userId, is_active: true }).lean();
    }
    throw err;
  }
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
  // STEP 1 — atomically flip the matching ACTIVE step to completed. The
  // positional filter (`steps.bundle_id` + `steps.status:'active'`) means a
  // concurrent re-grade / BullMQ retry that races here finds no active step
  // to match and returns null — so the step can never be double-completed.
  const completed = await TrackEnrollment.findOneAndUpdate(
    {
      user_id: userId,
      is_active: true,
      steps: { $elemMatch: { bundle_id: bundleId, status: 'active' } },
    },
    {
      $set: {
        'steps.$.status': 'completed',
        'steps.$.session_id': sessionId,
        'steps.$.overall_score': typeof overallScore === 'number' ? overallScore : null,
        'steps.$.completed_at': new Date(),
      },
    },
    { new: true }
  );
  if (!completed) return { advanced: false };

  // STEP 2 — unlock the next step (or complete the track). Done as a second
  // targeted update; idempotent because step 1 already consumed the race.
  const idx = completed.steps.findIndex((s) => String(s.bundle_id) === String(bundleId));
  if (idx >= 0 && idx + 1 < completed.steps.length) {
    await TrackEnrollment.updateOne(
      { _id: completed._id, [`steps.${idx + 1}.status`]: 'locked' },
      { $set: { [`steps.${idx + 1}.status`]: 'active', current_step: idx + 1 } }
    );
    return { advanced: true, completed: false, next_step: idx + 1 };
  }
  // Last step done → close the track.
  await TrackEnrollment.updateOne(
    { _id: completed._id, is_active: true },
    { $set: { is_active: false, current_step: completed.steps.length, completed_at: new Date() } }
  );
  return { advanced: true, completed: true, next_step: completed.steps.length };
}

/**
 * The active step's bundle_id for a learner's track, or null. Used by
 * planIntegration to prefer the track's next capstone over a random one.
 *
 * Self-healing (fixes the "stuck if a step bundle is retired mid-track"
 * bug): if the active step's bundle is no longer an attemptable capstone
 * (retired / archived / deleted / role-track changed), we skip it —
 * marking it completed-but-skipped and unlocking the next step — until we
 * land on an attemptable step or the track runs out (then close it). This
 * guarantees a learner can never be permanently stuck on a dead step.
 */
async function getActiveStepBundleId(userId, expectedRoleTrack = null) {
  // Bounded loop: at most one pass over the steps.
  for (let guard = 0; guard < 32; guard += 1) {
    const enrollment = await TrackEnrollment.findOne({ user_id: userId, is_active: true }).lean();
    if (!enrollment) return null;
    const step = enrollment.steps.find((s) => s.status === 'active');
    if (!step) return null;

    const bundle = await ArtifactBundle.findById(step.bundle_id)
      .select('status role_track')
      .lean();
    const attemptable =
      bundle &&
      bundle.status === 'active' &&
      (!expectedRoleTrack || bundle.role_track === expectedRoleTrack);

    if (attemptable) return String(step.bundle_id);

    // Dead/stale step — skip it via the same atomic advance machinery.
    const res = await advanceOnGrade(userId, step.bundle_id, null, null);
    if (!res.advanced) return null; // someone else moved it; bail to be safe
    if (res.completed) return null; // skipped the last step → track closed
    // else loop and re-check the newly-active step
  }
  return null;
}

function shorten(brief) {
  if (!brief) return '';
  // Just the title (first non-empty line), NOT the whole brief mashed onto one
  // line — the latter floods the track rows with body text.
  const firstLine = (String(brief).split('\n').find((l) => l.trim().length > 0) || '').trim();
  return firstLine.length > 90 ? firstLine.slice(0, 90).trimEnd() + '…' : firstLine;
}

module.exports = {
  getActiveEnrollment,
  enrollAutoTrack,
  advanceOnGrade,
  getActiveStepBundleId,
  TRACK_LENGTH,
};
