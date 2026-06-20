const mongoose = require('mongoose');
const InstitutionEnrollmentSchema = new mongoose.Schema({
  institutionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true },
  departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true },
  cohortId: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionCohort', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  pendingStudentId: { type: mongoose.Schema.Types.ObjectId, ref: 'PendingStudent' },
  rollNumber: String,
  status: { type: String, enum: ['pending', 'invited', 'registered', 'diagnostic_done', 'active', 'withdrawn'], default: 'pending' },
  consentAt: Date, joinedAt: Date, withdrawnAt: Date,
}, { timestamps: true });
InstitutionEnrollmentSchema.index({ institutionId: 1, cohortId: 1 });
InstitutionEnrollmentSchema.index({ institutionId: 1, userId: 1 }, { unique: true, partialFilterExpression: { userId: { $exists: true } } });
module.exports = mongoose.models.InstitutionEnrollment || mongoose.model('InstitutionEnrollment', InstitutionEnrollmentSchema);
