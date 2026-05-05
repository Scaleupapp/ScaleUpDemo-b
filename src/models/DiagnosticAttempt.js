const mongoose = require('mongoose');

/**
 * DiagnosticAttempt — BUG-8 Phase 4 (Day-1 Diagnostic, separate from Phase 1-9 of insights).
 *
 * One document per (user, attempt). Lifecycle:
 *   in_progress → completed (when finishAttempt is called)
 *   in_progress → abandoned (when abandon endpoint is called)
 *
 * Distinct from QuizAttempt because the diagnostic is a different artefact
 * (different questions, different scoring intent, different downstream effects).
 */

const answerSchema = new mongoose.Schema({
  questionId:     { type: mongoose.Schema.Types.ObjectId, required: true },
  competency:     { type: String, required: true },
  difficulty:     { type: String, enum: ['easy', 'medium', 'hard'], required: true },
  selectedAnswer: { type: String, required: true },
  isCorrect:      { type: Boolean, required: true },
  timeTaken:      { type: Number, default: 0 }, // seconds
}, { _id: false });

const competencyResultSchema = new mongoose.Schema({
  assessedBand:     { type: String, enum: ['novice', 'familiar', 'proficient', 'expert'] },
  score:            { type: Number, min: 0, max: 100 },
  calibrationDelta: { type: Number },           // -3..+3
  questionsAsked:   { type: Number, default: 0 },
}, { _id: false });

const diagnosticAttemptSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  flowType: { type: String, enum: ['new_user', 'existing_user_tune'], required: true },

  status: {
    type: String,
    enum: ['in_progress', 'completed', 'abandoned'],
    default: 'in_progress',
    index: true,
  },

  startedAt:    { type: Date, default: Date.now },
  completedAt:  { type: Date },
  abandonedAt:  { type: Date },
  abandonStrategy: {
    type: String,
    enum: [null, 'partial_processed', 'dropped'],
    default: null,
  },

  // Pool used for this attempt (refs into DiagnosticQuestionBank)
  poolQuestionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'DiagnosticQuestionBank' }],

  // Self-rating snapshot at attempt time
  selfRatings: {
    type: Map,
    of: { type: String, enum: ['novice', 'familiar', 'proficient', 'expert', 'unsure'] },
    default: () => new Map(),
  },

  answers: [answerSchema],

  results: {
    type: Map,
    of: competencyResultSchema,
    default: () => new Map(),
  },

  // Snapshot of the user's primary objective at attempt creation; used by the
  // retake cooldown to detect objective changes (Edge 6), and by submitSelfRating
  // to pass the objective label to the pool assembler.
  objectiveSnapshot: {
    _id: { type: mongoose.Schema.Types.ObjectId, ref: 'UserObjective' },
    label: { type: String, default: null },
  },

  // Telemetry
  cohort: { type: String }, // 'pre_diagnostic' | 'post_diagnostic_taken' | etc.
  confidence: { type: String, enum: ['high', 'medium', 'low'], default: 'high' },

  // Idempotency checkpoint: set immediately after _applyToKnowledgeProfile succeeds.
  // Allows future replay tooling to detect partially-applied attempts without
  // re-running the profile update.
  appliedToProfileAt: { type: Date, default: null },

  // --- Insights & plan handoff (spec §4.4) ---
  insightsJson: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  planGenerationStatus: {
    type: String,
    enum: ['pending', 'generating', 'ready', 'failed'],
    default: 'pending',
    index: true,
  },

  // --- Attempt provenance (spec §3.5 / §4.4) ---
  attemptType: {
    type: String,
    enum: ['initial', 'recalibration'],
    default: 'initial',
    index: true,
  },
  previousAttemptId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DiagnosticAttempt',
    default: null,
  },
}, { timestamps: true });

diagnosticAttemptSchema.index({ userId: 1, status: 1, startedAt: -1 });
diagnosticAttemptSchema.index({ userId: 1, status: 1, completedAt: -1 });
// At-most-one active attempt per user (in_progress only);
// startAttempt abandons priors before creating a new one.
diagnosticAttemptSchema.index(
  { userId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'in_progress' },
    name: 'one_active_attempt_per_user',
  },
);

module.exports = mongoose.model('DiagnosticAttempt', diagnosticAttemptSchema);
