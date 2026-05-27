'use strict';

const mongoose = require('mongoose');

/**
 * CapstoneRecording — metadata about a session's event stream. The actual
 * event log is in S3 (key on this doc); Mongo just tracks the index, byte
 * range, and summary stats so we can drive the Replay scrubber without
 * pulling the whole stream down.
 *
 * One recording per session (1:1 with CapstoneSession). Created when the
 * web IDE first connects to the WS room; finalized on submit.
 *
 * Spec §7.4: raw event stream lives in S3 for 90 days; pre-rendered replay
 * artifact regenerated on demand if it fails.
 */

const EventSummarySchema = new mongoose.Schema(
  {
    // Cumulative counts by event type. Used by the Replay timeline to render
    // markers without scanning the full stream.
    file_writes: { type: Number, default: 0 },
    file_reads: { type: Number, default: 0 },
    commands: { type: Number, default: 0 },
    test_results: { type: Number, default: 0 },
    compass_turns: { type: Number, default: 0 },
    tab_blurs: { type: Number, default: 0 },
    pastes: { type: Number, default: 0 },
  },
  { _id: false }
);

const SnapshotIndexSchema = new mongoose.Schema(
  {
    // Wall-clock seconds since session started.
    t_seconds: { type: Number, required: true },
    // S3 key for the pre-rendered code snapshot at this moment. Snapshots
    // are taken every 30s during the session by recordingService so the
    // Replay scrubber doesn't have to re-apply the event log from t=0.
    s3_key: { type: String, required: true },
  },
  { _id: false }
);

const FlaggedMomentSchema = new mongoose.Schema(
  {
    t_seconds: { type: Number, required: true },
    // Populated by the evaluator (WS4) — moments worth highlighting in
    // Replay (e.g. "here you accepted a buggy Compass suggestion").
    label: { type: String, required: true },
    detail: String,
    severity: { type: String, enum: ['info', 'warning', 'critical'], default: 'info' },
  },
  { _id: false }
);

const CapstoneRecordingSchema = new mongoose.Schema(
  {
    session_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CapstoneSession',
      required: true,
      unique: true,
      index: true,
    },

    // S3 key for the append-only newline-delimited JSON event stream.
    // Format: { t: ISO, type, payload, seq }
    event_stream_s3_key: { type: String, required: true },

    // Final size in bytes (set when stream is finalized on submit). Lets us
    // size-cap retention scans without reading.
    event_stream_bytes: { type: Number, default: 0 },
    event_count: { type: Number, default: 0 },

    // Compact summary so the timeline can render without fetching the
    // stream. Updated periodically by the recording service.
    summary: EventSummarySchema,

    // Snapshot rendering checkpoints (one every 30s in the session).
    snapshots: [SnapshotIndexSchema],

    // Evaluator-flagged moments (populated by WS4 evaluator).
    flagged_moments: [FlaggedMomentSchema],

    // Retention: spec §7.4 says 90 days. Periodic cleanup job removes both
    // the S3 stream and this doc after expiry.
    expires_at: {
      type: Date,
      required: true,
      index: { expireAfterSeconds: 0 },
    },

    finalized_at: Date,
  },
  { timestamps: true }
);

module.exports = mongoose.model('CapstoneRecording', CapstoneRecordingSchema);
