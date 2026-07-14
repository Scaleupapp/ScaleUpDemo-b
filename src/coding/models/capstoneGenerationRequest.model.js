'use strict';

const mongoose = require('mongoose');

/**
 * Tracks one learner-initiated OR institution-authored capstone-generation
 * request through its async lifecycle so the client can fire-and-poll. The
 * actual bundle is created by the generator mid-flight; bundle_id is filled
 * in once it exists.
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
 *
 * Ownership — exactly ONE of two modes (enforced by the pre('validate') hook
 * below), never neither, never both:
 *   D2C:         user_id set, institution_id unset — one student generating
 *                their own capstone (the original, still-supported flow).
 *   Institution: institution_id set, user_id unset — a TPO / author agent
 *                authoring a capstone for a COHORT, which has no single
 *                student owner. cohort_id / assessment_id /
 *                requested_by_institution_user are optional enrichment on
 *                top of that anchor, not separate ownership signals.
 *
 * user_id is intentionally NOT required at the schema level any more — it
 * used to be `required: true`, which is exactly what let an institution
 * caller (which has no student user to put here) either crash with an
 * opaque "user_id is required" ValidationError, or — worse, on the path that
 * passed assessment.createdBy anyway — silently stuff an InstitutionUser id
 * into a field typed `ref: 'User'`, which any `populate('user_id')` would
 * then quietly fail to resolve.
 */
const CapstoneGenerationRequestSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    institution_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', index: true },
    cohort_id: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionCohort' },
    assessment_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Assessment', index: true },
    requested_by_institution_user: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionUser' },
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

/**
 * Ownership guard: exactly one of user_id (D2C) / institution_id
 * (institution) must be set. Neither -> the request has no owner at all
 * (the original bug — an institution caller with nothing to put in user_id
 * used to sail through undetected until Mongoose's `required: true` on
 * user_id happened to catch SOME of those cases with an opaque message).
 * Both -> ambiguous ownership, never legitimate. Either way we fail loudly
 * and specifically here, before the document is ever persisted.
 */
CapstoneGenerationRequestSchema.pre('validate', function ownershipModeGuard(next) {
  const hasUser = this.user_id != null;
  const hasInstitution = this.institution_id != null;

  if (hasUser === hasInstitution) {
    this.invalidate(
      'user_id',
      'a generation request must be owned by either a user (D2C) or an institution'
    );
  }

  next();
});

CapstoneGenerationRequestSchema.index({ user_id: 1, createdAt: -1 });
CapstoneGenerationRequestSchema.index({ institution_id: 1, createdAt: -1 });
CapstoneGenerationRequestSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

module.exports =
  mongoose.models.CapstoneGenerationRequest ||
  mongoose.model('CapstoneGenerationRequest', CapstoneGenerationRequestSchema);
