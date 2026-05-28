'use strict';

const mongoose = require('mongoose');

/**
 * CapstoneSession — represents a single learner's attempt at a capstone bundle.
 *
 * Lifecycle (spec §7.2):
 *   scheduled → provisioning → ready → in_progress
 *     → (paused ↔ in_progress)*
 *     → submitted → evaluating → graded
 *   plus terminal branches: aborted, expired (which auto-transitions to submitted)
 *
 * Why one model instead of two (session + result):
 *   Result fields are only populated post-eval. Keeping them on the session
 *   doc means a single round-trip to render the Capstone Results screen, and
 *   the eval job updates one document. Lifecycle queries (mobile heartbeat
 *   for an active session, dashboard for graded ones) all hit the same
 *   collection — no cross-collection joins for the hot path.
 */

const DimensionScoresSchema = new mongoose.Schema(
  {
    correctness: Number,
    code_quality: Number,
    ai_pair_effectiveness: Number,
    verification_discipline: Number,
    decomposition: Number,
    reflection_quality: Number,
  },
  { _id: false }
);

const SessionResultSchema = new mongoose.Schema(
  {
    overall_score: Number,
    dimension_scores: DimensionScoresSchema,
    strengths: [String],
    gaps: [String],
    interview_parallel: String,
    integrity_confidence: { type: String, enum: ['high', 'medium', 'low'] },
    // Anchor drift detection (spec §8.3). If any anchor disagrees with the
    // evaluator by > 2 points, this flips true and the result is re-flagged.
    anchor_drift_detected: { type: Boolean, default: false },
    evaluator_model: String,
    graded_at: Date,
    // LLM's narrative explanation of why these scores. Cites specific files,
    // test names, or Compass turns. Surfaced on the result screen as the
    // "Detailed analysis" block so learners understand the verdict.
    evidence_notes: String,
  },
  { _id: false }
);

const CapstoneSessionSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    bundle_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ArtifactBundle', required: true, index: true },

    status: {
      type: String,
      enum: [
        'scheduled',
        'provisioning',
        'ready',
        'in_progress',
        'paused',
        'submitted',
        'evaluating',
        'graded',
        'aborted',
        'expired',
      ],
      default: 'scheduled',
      required: true,
      index: true,
    },

    // Sandbox provider attribution — `sandbox_provider` is forward-compat for
    // when we add Daytona / self-host. `sandbox_id` is the provider's handle
    // so we can reconnect or destroy at any time.
    sandbox_provider: { type: String, enum: ['e2b', 'daytona', 'local'], default: 'e2b' },
    sandbox_id: String,
    sandbox_host_url: String,

    // Cross-reference back to the redeemed pairing code (if any). Web-only
    // entries (no mobile handoff) leave this null.
    pairing_code_used: String,

    // Lifecycle timestamps. Each transition writes the relevant one in the
    // state machine (sessionStateMachine.js, lands in WS2).
    started_at: Date,
    paused_at: Date,
    submitted_at: Date,
    evaluating_started_at: Date,
    graded_at: Date,
    expires_at: Date,

    // Time budget snapshot from the bundle at provision time, so a bundle
    // edit later doesn't change a learner's running session.
    time_budget_seconds: { type: Number, required: true },
    // Accumulated pause time so the timer is wall-clock minus pauses.
    paused_total_seconds: { type: Number, default: 0 },

    // S3 keys for the recording, final diff, voice reflection. Resolved
    // server-side into presigned URLs by /capstones/:id/replay.
    recording_s3_key: String,
    final_diff_s3_key: String,
    voice_reflection_s3_key: String,
    voice_reflection_transcript: String,

    // Counter cache for `session.stats` heartbeat — incremented by the
    // recording service so the heartbeat doesn't have to S3-scan every tick.
    counters: {
      files_changed: { type: Number, default: 0 },
      compass_turns: { type: Number, default: 0 },
      tests_run: { type: Number, default: 0 },
      tests_passing: { type: Number, default: 0 },
      tests_total: { type: Number, default: 0 },
      paste_events: { type: Number, default: 0 },
      tab_blur_events: { type: Number, default: 0 },
    },

    result: SessionResultSchema,

    // True when this session was created via /retry against a previously
    // graded bundle. Used by the result screen to show a "vs. last attempt"
    // delta and by analytics to track replay engagement.
    is_retry: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Hot queries:
//   - mobile heartbeat: by (user_id, status: in_progress | paused)
//   - results landing screen: by (user_id, status: graded), sort by graded_at desc
CapstoneSessionSchema.index({ user_id: 1, status: 1, graded_at: -1 });
// Eval worker pulls expired sessions and auto-submits them
CapstoneSessionSchema.index({ status: 1, expires_at: 1 });

module.exports = mongoose.model('CapstoneSession', CapstoneSessionSchema);
