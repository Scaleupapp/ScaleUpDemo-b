'use strict';

const mongoose = require('mongoose');

/**
 * Tracks one learner-initiated capstone-generation request through its async
 * lifecycle so the client can fire-and-poll. The actual bundle is created by
 * the generator mid-flight; bundle_id is filled in once it exists.
 *
 * Lifecycle:
 *   queued → generating → validating → cross_checking → ready
 *                                                    ↘ failed
 *
 *   - generating    : LLM is drafting the bundle (+ sandbox reference-solution proof)
 *   - validating    : deterministic checks (reference solution runs green, non-
 *                     solution fails, tests distinct, hash unique)
 *   - cross_checking : a DIFFERENT model adversarially reviews the bundle
 *   - ready         : bundle is status='active' and attemptable
 *   - failed        : exhausted retries or cross-check rejected; reason in `error`
 */
const CapstoneGenerationRequestSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    job_description: { type: String, default: '' },
    topic_hint: { type: String, default: '' },
    role_track: { type: String, enum: ['swe', 'ds', 'ai_eng'], required: true },
    difficulty: { type: String, enum: ['easy', 'medium', 'hard'], required: true },
    language: { type: String, required: true },
    status: {
      type: String,
      enum: ['queued', 'generating', 'validating', 'cross_checking', 'ready', 'failed'],
      default: 'queued',
      required: true,
      index: true,
    },
    bundle_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ArtifactBundle', default: null },
    attempts: { type: Number, default: 0 },
    error: { type: String, default: null },
    cross_check_notes: { type: String, default: null },
    // Auto-clean stale requests after 7 days.
    expires_at: { type: Date, default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
  },
  { timestamps: true }
);

CapstoneGenerationRequestSchema.index({ user_id: 1, createdAt: -1 });
CapstoneGenerationRequestSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

module.exports =
  mongoose.models.CapstoneGenerationRequest ||
  mongoose.model('CapstoneGenerationRequest', CapstoneGenerationRequestSchema);
