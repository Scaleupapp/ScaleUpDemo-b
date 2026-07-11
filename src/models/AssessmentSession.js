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
}, { timestamps: true });

// One attempt per student per assessment — enforces single attempt.
AssessmentSessionSchema.index({ assessmentId: 1, userId: 1 }, { unique: true });
AssessmentSessionSchema.index({ institutionId: 1, cohortId: 1, status: 1 });

module.exports = mongoose.models.AssessmentSession || mongoose.model('AssessmentSession', AssessmentSessionSchema);
