const mongoose = require('mongoose');
const InstitutionAuditLogSchema = new mongoose.Schema({
  institutionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionUser' },
  action: { type: String, required: true },
  target: String,
  before: mongoose.Schema.Types.Mixed,
  after: mongoose.Schema.Types.Mixed,
  ip: String,
}, { timestamps: true });
module.exports = mongoose.models.InstitutionAuditLog || mongoose.model('InstitutionAuditLog', InstitutionAuditLogSchema);
