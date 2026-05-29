'use strict';

const s3 = require('../../config/s3');
const CapstoneRecording = require('../models/capstoneRecording.model');
const CapstoneSession = require('../models/capstoneSession.model');
const sandboxOrchestrator = require('./sandboxOrchestrator');
const finalHarness = require('./capstoneEvaluator/finalHarness');

/**
 * Snapshot service (spec §7.4) — periodically grabs the learner's full
 * filetree from the sandbox and writes it to S3 as a compact JSON blob.
 * The Replay scrubber uses these snapshots so it doesn't have to replay
 * the entire event log from t=0 every time the user drags the timeline.
 *
 * Cadence: every SNAPSHOT_INTERVAL_SEC of session wall-clock + one on
 * submit. The capstone-eval-worker tick polls active sessions and calls
 * captureForSession() — keeping the snapshotting tied to the same worker
 * we already run means no new BullMQ queue.
 */

const SNAPSHOT_INTERVAL_SEC = 60;
const MAX_FILES_PER_SNAPSHOT = 200;
const SNAPSHOT_RETENTION_DAYS = 90; // matches recording stream

/**
 * Capture a snapshot of the current sandbox filetree and append to the
 * recording. Idempotent on (session_id, t_seconds) — if a snapshot at
 * the current t already exists, this is a no-op.
 *
 * @param {string} sessionId
 * @returns {Promise<{ captured: boolean, t_seconds: number, s3_key?: string }>}
 */
async function captureForSession(sessionId) {
  const session = await CapstoneSession.findById(sessionId).lean();
  if (!session) return { captured: false, t_seconds: 0 };
  if (!session.sandbox_id) return { captured: false, t_seconds: 0 };
  // 'submitted' is included BECAUSE the submit-time capture in applyControl
  // runs AFTER the state transition but BEFORE sandbox teardown. Without
  // it, the final snapshot is never written, the sandbox is reaped, and
  // the evaluator sees an empty filetree — the diff renders as "all
  // implementation was deleted" and scores ~1/100 for a learner who
  // actually wrote code.
  if (!['ready', 'in_progress', 'paused', 'submitted'].includes(session.status)) {
    return { captured: false, t_seconds: 0 };
  }

  const startedAt = session.started_at || session.createdAt || new Date();
  const tSeconds = Math.floor(
    (Date.now() - new Date(startedAt).getTime()) / 1000 - (session.paused_total_seconds || 0)
  );

  // Don't capture a snapshot more often than SNAPSHOT_INTERVAL_SEC.
  const recording = await CapstoneRecording.findOne({ session_id: sessionId }).lean();
  if (recording?.snapshots?.length) {
    const last = recording.snapshots[recording.snapshots.length - 1];
    if (last && tSeconds - last.t_seconds < SNAPSHOT_INTERVAL_SEC) {
      return { captured: false, t_seconds: last.t_seconds };
    }
  }

  // Pull files via the same path the evaluator uses, but capped lower
  // (we capture often, so each snapshot needs to be cheap).
  const files = await finalHarness
    .pullFinalFiles({ sandboxId: session.sandbox_id, snapshotFiles: null })
    .catch(() => null);
  if (!files || files.length === 0) return { captured: false, t_seconds: tSeconds };

  const capped = files.slice(0, MAX_FILES_PER_SNAPSHOT);
  const s3Key = `capstone-recordings/${sessionId}/snapshots/t-${tSeconds}.json`;
  const payload = JSON.stringify({ t_seconds: tSeconds, files: capped });
  await s3.uploadBuffer(s3Key, Buffer.from(payload), 'application/json');

  await CapstoneRecording.findOneAndUpdate(
    { session_id: sessionId },
    { $push: { snapshots: { t_seconds: tSeconds, s3_key: s3Key } } }
  );

  return { captured: true, t_seconds: tSeconds, s3_key: s3Key };
}

/**
 * Resolve a snapshot to its filetree (used by the replay endpoint to
 * return the actual content + presigned URL). Returns null if the
 * snapshot or its S3 object is missing.
 */
async function loadSnapshot(s3Key) {
  try {
    const buf = await s3.downloadBuffer(s3Key);
    if (!buf || buf.length === 0) return null;
    const parsed = JSON.parse(buf.toString('utf8'));
    return parsed;
  } catch {
    return null;
  }
}

module.exports = {
  captureForSession,
  loadSnapshot,
  SNAPSHOT_INTERVAL_SEC,
  SNAPSHOT_RETENTION_DAYS,
};

// Suppress unused import warning if sandboxOrchestrator isn't used in the
// happy path — we keep the require so future direct sandbox calls don't
// have to re-add it.
void sandboxOrchestrator;
