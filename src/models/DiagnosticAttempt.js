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
  calibrationClass: { type: String, enum: ['well-calibrated', 'overestimates', 'undersells'], default: 'well-calibrated' },
  questionsAsked:   { type: Number, default: 0 },
  // True when the user declared this topic but zero questions were available
  // in the pool (bank empty + LLM gen failed). Sentinel entry only — score
  // and band are absent. Client should render "Not tested" rather than "—".
  notTested:        { type: Boolean, default: false },
}, { _id: false });

const diagnosticAttemptSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // 'existing_user_tune' is retained on the enum for backward-compat with
  // legacy DB docs; the current engine only ever writes 'new_user' or
  // 'recalibration'.
  flowType: { type: String, enum: ['new_user', 'existing_user_tune', 'recalibration'], required: true },

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

  // Snapshot of the user's primary objective at attempt creation; used to
  // pass the objective label to the pool assembler and to scope KnowledgeProfile
  // entries by objective.
  objectiveSnapshot: {
    _id: { type: mongoose.Schema.Types.ObjectId, ref: 'UserObjective' },
    label: { type: String, default: null },
  },

  // Telemetry
  cohort: { type: String }, // 'pre_diagnostic' | 'post_diagnostic_taken' | etc.
  confidence: { type: String, enum: ['high', 'medium', 'low'], default: 'high' },

  // Idempotency checkpoint for legacy KnowledgeProfile updates. Retained so
  // older attempt documents continue to deserialize cleanly; not written by
  // the current engine.
  appliedToProfileAt: { type: Date, default: null },

  // --- Insights & plan handoff (spec §4.4 / §10.5) ---
  insightsStatus: {
    type: String,
    enum: ['pending', 'generating', 'completed', 'fallback', 'error'],
    default: 'pending',
  },
  insightsSource: {
    type: String,
    enum: ['llm', 'template'],
    default: undefined,
  },
  insightsJson: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  insightsLatencyMs: { type: Number, default: null },
  planGenerationStatus: {
    type: String,
    // 'awaiting_reality_check' — v2 only: diagnostic done, plan generation
    // deferred until the user confirms hours on the v2 Reality Check screen.
    enum: ['pending', 'awaiting_reality_check', 'generating', 'ready', 'failed'],
    default: 'pending',
    index: true,
  },
  planId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Plan',
    default: null,
  },

  // --- Re-calibration growth results (spec §3.5 / Plan 4 Task 10) ---
  recalibrationGrowth: {
    growthBars: [{
      canonicalName: String,
      oldScore: Number,
      newScore: Number,
      delta: Number,
      oldBand: String,
      newBand: String,
      bandShift: String,
    }],
    biggestJump: {
      canonicalName: { type: String, default: null },
      delta: { type: Number, default: null },
      bandShift: { type: String, default: null },
    },
    newGaps: [String],
    summary: { type: String, default: null },
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
