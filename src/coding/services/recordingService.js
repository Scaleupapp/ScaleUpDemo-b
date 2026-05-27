'use strict';

const crypto = require('crypto');
const s3 = require('../../config/s3');
const CapstoneSession = require('../models/capstoneSession.model');
const CapstoneRecording = require('../models/capstoneRecording.model');

/**
 * Recording service — append-only event stream per capstone session.
 *
 * Why S3 + Mongo (and not just Mongo):
 *   - Streams can be MB-scale per session over 90 min; Mongo doc size limit is 16 MB
 *   - S3 is cheaper for retention (spec §7.4 says 90-day window)
 *   - We never query inside the stream — only render via Replay (sequential read)
 *
 * Why we dedup `file_write` events:
 *   - WS0.3 finding: e2b fires 3 events per file write (create+modify+close).
 *     Without dedup the stream balloons and the AI-pair-effectiveness signal
 *     gets polluted with non-meaningful events.
 *
 * Buffering strategy:
 *   - In-process buffer per session, flushed every FLUSH_INTERVAL_MS or
 *     when buffer hits FLUSH_SIZE_BYTES, whichever first.
 *   - On submit, `finalize()` flushes any remaining buffer + updates the
 *     recording doc with final byte count + event count.
 *   - Process crash mid-flight = lose up to FLUSH_INTERVAL_MS of events.
 *     Acceptable; recording is best-effort, not authoritative (the
 *     authoritative state is the diff at submit time).
 */

const FLUSH_INTERVAL_MS = 10_000; // 10 sec — also the mobile heartbeat cadence
const FLUSH_SIZE_BYTES = 64 * 1024; // 64 KB
const RETENTION_DAYS = 90;
const DEDUP_WINDOW_MS = 1500; // dedup file_write events within this window

/**
 * Per-session in-memory buffers. Keyed by sessionId string. The shape:
 *
 *   {
 *     events: Array<{ t: string, type: string, payload: object, seq: number }>
 *     bytes: number
 *     seqNext: number
 *     lastFlushAt: number
 *     timer: NodeJS.Timeout
 *     dedupCache: Map<string, number>   // path → last file_write timestamp
 *   }
 */
const buffers = new Map();

/**
 * Start recording for a session. Creates the CapstoneRecording doc + an
 * empty S3 stream object, kicks off the per-session flush timer.
 *
 * Idempotent — calling on a session that already has a recording returns
 * the existing one.
 *
 * @param {import('mongoose').Types.ObjectId|string} sessionId
 * @returns {Promise<{ recordingId: import('mongoose').Types.ObjectId, eventStreamS3Key: string }>}
 */
async function startRecording(sessionId) {
  const existing = await CapstoneRecording.findOne({ session_id: sessionId }).lean();
  if (existing) {
    ensureBuffer(sessionId);
    return {
      recordingId: existing._id,
      eventStreamS3Key: existing.event_stream_s3_key,
    };
  }

  const eventStreamS3Key = `capstone-recordings/${sessionId}/events.ndjson`;
  const expiresAt = new Date(Date.now() + RETENTION_DAYS * 24 * 60 * 60 * 1000);

  // Initialise the S3 object with an empty body so subsequent appends
  // (via multipart re-upload of whole buffer) have something to overwrite.
  await s3.uploadBuffer(eventStreamS3Key, Buffer.alloc(0), 'application/x-ndjson');

  const doc = await CapstoneRecording.create({
    session_id: sessionId,
    event_stream_s3_key: eventStreamS3Key,
    event_stream_bytes: 0,
    event_count: 0,
    summary: {},
    snapshots: [],
    flagged_moments: [],
    expires_at: expiresAt,
  });

  // Persist the key on the session doc for fast lookup by /replay.
  await CapstoneSession.findByIdAndUpdate(sessionId, {
    recording_s3_key: eventStreamS3Key,
  });

  ensureBuffer(sessionId);

  return { recordingId: doc._id, eventStreamS3Key };
}

/**
 * Push an event into the session's buffer. Dedups file_write events for
 * the same path within DEDUP_WINDOW_MS (WS0.3 over-fire fix).
 *
 * Recognized event types: file_write, file_read, command_run, test_result,
 * compass_turn, tab_blur, paste, session_lifecycle, focus_change.
 * Anything else is accepted but won't increment a summary counter.
 *
 * @param {string} sessionId
 * @param {{ type: string, payload?: object }} event
 */
function emit(sessionId, event) {
  if (!event || !event.type) return;
  const buf = ensureBuffer(sessionId);

  // Dedup file_write: same path within DEDUP_WINDOW_MS = one event.
  if (event.type === 'file_write') {
    const path = event.payload?.path;
    if (path) {
      const lastAt = buf.dedupCache.get(path);
      if (lastAt && Date.now() - lastAt < DEDUP_WINDOW_MS) {
        return;
      }
      buf.dedupCache.set(path, Date.now());
    }
  }

  const enriched = {
    t: new Date().toISOString(),
    type: event.type,
    payload: event.payload || {},
    seq: buf.seqNext++,
  };
  const line = JSON.stringify(enriched) + '\n';
  buf.events.push(enriched);
  buf.bytes += Buffer.byteLength(line);

  if (buf.bytes >= FLUSH_SIZE_BYTES) {
    // Don't await — flush is fire-and-forget. Next call will re-flush if
    // this one fails (the buffer doesn't clear until upload succeeds).
    void flush(sessionId);
  }
}

/**
 * Flush the buffer to S3. Re-uploads the whole stream object each time
 * (S3 has no native append). At 64KB-per-flush + 10-sec cadence over a
 * 90-min session, total writes ≈ 540; total data ≈ 35 MB worst case.
 * Acceptable cost given S3's PUT pricing.
 */
async function flush(sessionId) {
  const buf = buffers.get(sessionId);
  if (!buf || buf.events.length === 0) return;
  const inflight = buf.events.slice();
  buf.events = [];
  buf.bytes = 0;

  try {
    const recording = await CapstoneRecording.findOne({ session_id: sessionId });
    if (!recording) return;

    // Append to the in-S3 stream by reading current + writing combined.
    // For long sessions this is O(n²) bytes transferred; replace with
    // multipart append in a future iteration if it becomes a hotspot.
    // For now (90-min capstones, target traffic) it's acceptable.
    const existingBuf = await s3.downloadBuffer(recording.event_stream_s3_key).catch(() => Buffer.alloc(0));
    const newLines = inflight.map((e) => JSON.stringify(e)).join('\n') + '\n';
    const combined = Buffer.concat([existingBuf, Buffer.from(newLines)]);
    await s3.uploadBuffer(recording.event_stream_s3_key, combined, 'application/x-ndjson');

    // Update summary counters atomically.
    const incs = inflight.reduce((acc, e) => {
      const k = summaryKeyFor(e.type);
      if (k) acc[`summary.${k}`] = (acc[`summary.${k}`] || 0) + 1;
      return acc;
    }, {});
    incs.event_stream_bytes = combined.length - recording.event_stream_bytes;
    incs.event_count = inflight.length;

    await CapstoneRecording.findByIdAndUpdate(recording._id, { $inc: incs });

    // Mirror selected counters onto the session doc so the heartbeat
    // doesn't have to read the recording doc every 10 sec.
    await mirrorCountersToSession(sessionId, inflight);

    buf.lastFlushAt = Date.now();
  } catch (err) {
    // Put events back so the next flush retries them.
    buf.events = inflight.concat(buf.events);
    buf.bytes += Buffer.byteLength(inflight.map((e) => JSON.stringify(e)).join('\n') + '\n');
    // eslint-disable-next-line no-console
    console.warn(`[recordingService] flush failed for ${sessionId}:`, err.message);
  }
}

/**
 * Final flush + finalize. Called from sessions.controller on submit.
 * Stops the buffer timer and marks the recording finalized.
 */
async function finalize(sessionId) {
  await flush(sessionId);
  const buf = buffers.get(sessionId);
  if (buf?.timer) clearInterval(buf.timer);
  buffers.delete(sessionId);
  await CapstoneRecording.findOneAndUpdate(
    { session_id: sessionId },
    { $set: { finalized_at: new Date() } }
  );
}

/**
 * Append a snapshot of the working tree to the recording index.
 * Called periodically by the snapshot service (WS8.1) or on-demand
 * (e.g., right before submit).
 */
async function appendSnapshot(sessionId, { t_seconds, s3_key }) {
  await CapstoneRecording.findOneAndUpdate(
    { session_id: sessionId },
    { $push: { snapshots: { t_seconds, s3_key } } }
  );
}

/**
 * Append an evaluator-flagged moment (used by WS4 evaluator output).
 */
async function appendFlaggedMoment(sessionId, moment) {
  await CapstoneRecording.findOneAndUpdate(
    { session_id: sessionId },
    { $push: { flagged_moments: moment } }
  );
}

// -------- internals --------

function ensureBuffer(sessionId) {
  const key = String(sessionId);
  let buf = buffers.get(key);
  if (buf) return buf;
  buf = {
    events: [],
    bytes: 0,
    seqNext: 0,
    lastFlushAt: 0,
    dedupCache: new Map(),
    timer: setInterval(() => {
      void flush(key);
    }, FLUSH_INTERVAL_MS),
  };
  // Don't keep the event loop alive on this timer alone (e.g., during tests).
  if (buf.timer.unref) buf.timer.unref();
  buffers.set(key, buf);
  return buf;
}

function summaryKeyFor(type) {
  switch (type) {
    case 'file_write':       return 'file_writes';
    case 'file_read':        return 'file_reads';
    case 'command_run':      return 'commands';
    case 'test_result':      return 'test_results';
    case 'compass_turn':     return 'compass_turns';
    case 'tab_blur':         return 'tab_blurs';
    case 'paste':            return 'pastes';
    default:                  return null;
  }
}

async function mirrorCountersToSession(sessionId, events) {
  const inc = {};
  for (const e of events) {
    switch (e.type) {
      case 'file_write':
        inc['counters.files_changed'] = (inc['counters.files_changed'] || 0) + 1;
        break;
      case 'compass_turn':
        inc['counters.compass_turns'] = (inc['counters.compass_turns'] || 0) + 1;
        break;
      case 'command_run':
        inc['counters.tests_run'] = (inc['counters.tests_run'] || 0) + 1;
        break;
      case 'test_result':
        if (e.payload?.passed) {
          inc['counters.tests_passing'] = (inc['counters.tests_passing'] || 0) + 1;
        }
        inc['counters.tests_total'] = (inc['counters.tests_total'] || 0) + 1;
        break;
      case 'paste':
        inc['counters.paste_events'] = (inc['counters.paste_events'] || 0) + 1;
        break;
      case 'tab_blur':
        inc['counters.tab_blur_events'] = (inc['counters.tab_blur_events'] || 0) + 1;
        break;
      default:
    }
  }
  if (Object.keys(inc).length > 0) {
    await CapstoneSession.findByIdAndUpdate(sessionId, { $inc: inc });
  }
}

module.exports = {
  startRecording,
  emit,
  flush,
  finalize,
  appendSnapshot,
  appendFlaggedMoment,
  // Exposed for tests
  _buffers: buffers,
  DEDUP_WINDOW_MS,
  FLUSH_INTERVAL_MS,
  FLUSH_SIZE_BYTES,
};
