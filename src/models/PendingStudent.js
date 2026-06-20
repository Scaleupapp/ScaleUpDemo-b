const mongoose = require('mongoose');
const PendingStudentSchema = new mongoose.Schema({
  institutionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true },
  departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true },
  cohortId: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionCohort', required: true },
  rosterUploadId: { type: mongoose.Schema.Types.ObjectId, ref: 'RosterUpload' },
  name: String,
  rollNumber: String,
  email: { type: String, lowercase: true, trim: true },
  phone: { type: String, trim: true },
  inviteToken: String,
  status: { type: String, enum: ['pending', 'invited', 'claimed', 'expired'], default: 'pending' },
  matchedUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
PendingStudentSchema.index({ institutionId: 1, email: 1 });
PendingStudentSchema.index({ institutionId: 1, phone: 1 });
module.exports = mongoose.models.PendingStudent || mongoose.model('PendingStudent', PendingStudentSchema);
