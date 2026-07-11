const mongoose = require('mongoose');

const AssessmentSessionSchema = new mongoose.Schema({
  assessmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Assessment', required: true },
  institutionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true },
  cohortId: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionCohort', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  enrollmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionEnrollment' },
  // Reference into the underlying engine session.
  engine: {
    type: { type: String, enum: ['mcq', 'capstone', 'interview', 'drill'], required: true },
    sessionId: { type: mongoose.Schema.Types.ObjectId }, // capstoneSession / interviewSession / quizAttempt id
    quizId: { type: mongoose.Schema.Types.ObjectId },     // mcq only: the per-student Quiz clone
  },
  status: { type: String, enum: ['scheduled', 'in_progress', 'submitted', 'graded', 'expired'], default: 'scheduled' },
  startedAt: Date,
  // Server-side duration enforcement (Wave 3 block 1). Set at start when the
  // assessment's engine config carries durationSeconds > 0:
  //   deadlineAt = min(startedAt + durationSeconds, closesAt when set).
  // Null ⇒ no per-session duration cap (only assessment.closesAt governs, via
  // the sync worker). A sync/worker tick past deadlineAt auto-finalizes: grade
  // what the engine has, else mark 'expired'. Additive — old clients ignore it.
  deadlineAt: Date,
  submittedAt: Date,
  gradedAt: Date,
  result: {
    score: Number,        // 0-100 overall (null when gradeStatus is 'insufficient')
    integrity: String,    // e.g. 'high'|'medium'|'low' | 'clean'|'minor_flags'|'suspicious'
    // Answer-side judge flag: grade is disputed → TPO surface shows "under review".
    needsReview: Boolean,
    // 'insufficient' ⇒ not enough evidence to grade (interview min-transcript gate).
    gradeStatus: String,
    raw: mongoose.Schema.Types.Mixed, // small summary copied from the engine result
  },
  // Client-reported take-flow integrity signals (Wave 3 block 4). Undefined until
  // the app POSTs them; presence marks the session as PROCTORED (a real signal)
  // for the integrity rollup. `flagged` is derived conservatively at ingestion:
  // any paste OR more than 3 app-backgroundings ⇒ 'minor_flags'.
  integritySignals: {
    type: new mongoose.Schema({
      appBackgroundedCount: { type: Number, default: 0 },
      focusLossSeconds: { type: Number, default: 0 },
      pasteCount: { type: Number, default: 0 },
      flagged: { type: Boolean, default: false },
      updatedAt: { type: Date },
    }, { _id: false }),
    default: undefined,
  },
}, { timestamps: true });

// One attempt per student per assessment — enforces single attempt.
AssessmentSessionSchema.index({ assessmentId: 1, userId: 1 }, { unique: true });
AssessmentSessionSchema.index({ institutionId: 1, cohortId: 1, status: 1 });

module.exports = mongoose.models.AssessmentSession || mongoose.model('AssessmentSession', AssessmentSessionSchema);
