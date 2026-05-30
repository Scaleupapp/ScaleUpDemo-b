'use strict';

const mongoose = require('mongoose');

/**
 * A learner's enrollment in an AUTO-ASSEMBLED capstone track.
 *
 * Per the founder decision, tracks are NOT curated fixed sequences — at
 * enrollment we select an ordered set of capstones for this specific learner
 * (their role_track, ramping difficulty, skipping ones they've already
 * graded). The selected sequence is frozen onto the enrollment so progress is
 * stable even if the library changes underneath.
 *
 * Progression: step 0 is `active` at enrollment; each subsequent step is
 * `locked` until the prior step's capstone is graded, at which point it flips
 * to `active` (unlock-on-grade).
 */
const TrackStepSchema = new mongoose.Schema(
  {
    bundle_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ArtifactBundle', required: true },
    difficulty: { type: String, enum: ['easy', 'medium', 'hard'] },
    brief_preview: { type: String, default: '' },
    status: { type: String, enum: ['locked', 'active', 'completed'], default: 'locked' },
    session_id: { type: mongoose.Schema.Types.ObjectId, ref: 'CapstoneSession', default: null },
    overall_score: { type: Number, default: null },
    completed_at: { type: Date, default: null },
  },
  { _id: false }
);

const TrackEnrollmentSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    role_track: { type: String, enum: ['swe', 'ds', 'ai_eng'], required: true },
    title: { type: String, default: '' },
    steps: { type: [TrackStepSchema], default: [] },
    current_step: { type: Number, default: 0 },
    is_active: { type: Boolean, default: true },
    enrolled_at: { type: Date, default: Date.now },
    completed_at: { type: Date, default: null },
  },
  { timestamps: true }
);

// Exactly one ACTIVE enrollment per user — enforced at the DB level so a
// race between two enroll calls can't create duplicate active tracks. The
// partial filter lets a user accumulate many *inactive* (completed) tracks.
TrackEnrollmentSchema.index(
  { user_id: 1, is_active: 1 },
  { unique: true, partialFilterExpression: { is_active: true } }
);

module.exports =
  mongoose.models.TrackEnrollment ||
  mongoose.model('TrackEnrollment', TrackEnrollmentSchema);
