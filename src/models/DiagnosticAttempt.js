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

  // Snapshot of the user's active objective at attempt time (used for retake cooldown override)
  objectiveSnapshot: {
    _id: { type: mongoose.Schema.Types.ObjectId, ref: 'UserObjective' },
  },

  // Telemetry
  cohort: { type: String }, // 'pre_diagnostic' | 'post_diagnostic_taken' | etc.
  confidence: { type: String, enum: ['high', 'medium', 'low'], default: 'high' },
}, { timestamps: true });

diagnosticAttemptSchema.index({ userId: 1, status: 1, startedAt: -1 });
diagnosticAttemptSchema.index({ userId: 1, status: 1, completedAt: -1 });
diagnosticAttemptSchema.index(
  { userId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ['in_progress', 'awaiting_self_rating'] } },
    name: 'one_active_attempt_per_user',
  },
);

module.exports = mongoose.model('DiagnosticAttempt', diagnosticAttemptSchema);
