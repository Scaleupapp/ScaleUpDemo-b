'use strict';

const mongoose = require('mongoose');

/**
 * One persisted readiness reading. Written best-effort whenever the overview
 * computes readiness, so we can (a) show history/trajectory and (b) compare the
 * shadow composite against the served legacy value during Phase 1 rollout.
 *
 * `value` is what was SERVED to the user. `shadow` holds the parallel composite
 * (Phase 1) so we can diff old-vs-new without changing what the user sees.
 */
const ReadinessSnapshotSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    objectiveId: { type: mongoose.Schema.Types.ObjectId, ref: 'UserObjective', index: true },
    value: { type: Number, required: true, min: 0, max: 100 },
    source: { type: String }, // 'plan' | 'journey' | 'knowledge' | 'floor' | 'composite'
    breakdown: { type: mongoose.Schema.Types.Mixed }, // optional served breakdown
    // Parallel composite reading (Phase 1 shadow). Null until composite runs.
    shadow: {
      value: { type: Number },
      confidence: { type: Number },
      coverage: { type: Number }, // fraction of objective weight actually assessed
      breakdown: { type: mongoose.Schema.Types.Mixed },
      delta: { type: Number }, // shadow.value - value, for quick scans
    },
  },
  { timestamps: true }
);

ReadinessSnapshotSchema.index({ userId: 1, objectiveId: 1, createdAt: -1 });

module.exports = mongoose.model('ReadinessSnapshot', ReadinessSnapshotSchema);
