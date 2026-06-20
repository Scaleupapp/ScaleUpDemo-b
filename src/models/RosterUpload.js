const mongoose = require('mongoose');
const RosterUploadSchema = new mongoose.Schema({
  institutionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
  departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true },
  cohortId: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionCohort', required: true },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionUser', required: true },
  rowCount: { type: Number, default: 0 },
  validRows: { type: Number, default: 0 },
  errors: [{ row: Number, field: String, reason: String }],
  status: { type: String, enum: ['validated', 'approved', 'committed'], default: 'validated' },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionUser' },
  approvedAt: Date,
}, { timestamps: true });
module.exports = mongoose.models.RosterUpload || mongoose.model('RosterUpload', RosterUploadSchema);
