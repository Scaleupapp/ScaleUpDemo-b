'use strict';

const s3 = require('../../config/s3');
const CapstoneSession = require('../models/capstoneSession.model');
const CapstoneRecording = require('../models/capstoneRecording.model');

/**
 * Replay controller — returns the presigned S3 URLs + snapshot index +
 * evaluator-flagged moments that drive the mobile + web Replay scrubbers
 * (spec §7.4).
 *
 * Voice-reflection upload + transcription + Reflection-Quality re-eval
 * is a separate end-to-end pipeline and lives entirely in WS8. The route
 * is intentionally not wired here — adding a half-functional endpoint
 * would violate the prod-readiness bar (see feedback_prod_readiness_bar).
 */

/** GET /api/coding/capstones/:session_id/replay */
async function getReplay(req, res) {
  const session = await CapstoneSession.findOne({
    _id: req.params.session_id,
    user_id: req.user.userId,
  })
    .select('_id status time_budget_seconds started_at')
    .lean();
  if (!session) return res.status(404).json({ error: 'session_not_found' });

  const recording = await CapstoneRecording.findOne({ session_id: session._id }).lean();
  if (!recording) {
    return res.status(404).json({ error: 'recording_not_found' });
  }

  // Presigned URLs expire in 1h — long enough for a typical replay watch.
  // If the user keeps the screen open longer than that, the iOS client
  // calls /replay again to re-issue.
  const eventStreamUrl = await s3.generateDownloadURL(recording.event_stream_s3_key);
  const snapshots = await Promise.all(
    (recording.snapshots || []).map(async (s) => ({
      t_seconds: s.t_seconds,
      snapshot_url: await s3.generateDownloadURL(s.s3_key),
    }))
  );

  const elapsedSeconds = session.started_at
    ? Math.max(0, Math.floor((Date.now() - session.started_at.getTime()) / 1000))
    : session.time_budget_seconds;

  res.json({
    session_id: String(session._id),
    event_stream_url: eventStreamUrl,
    duration_seconds: Math.min(elapsedSeconds, session.time_budget_seconds),
    snapshots,
    flagged_moments: recording.flagged_moments || [],
  });
}

module.exports = {
  getReplay,
};
