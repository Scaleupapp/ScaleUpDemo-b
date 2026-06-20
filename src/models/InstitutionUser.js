const mongoose = require('mongoose');
const InstitutionUserSchema = new mongoose.Schema({
  institutionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true },
  name: String,
  email: { type: String, required: true, lowercase: true, trim: true },
  phone: String,
  role: { type: String, enum: ['institution_admin', 'tpo_head', 'tpo_coordinator', 'faculty', 'viewer'], required: true },
  scope: { departmentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Department' }] },
  status: { type: String, enum: ['invited', 'active', 'disabled'], default: 'invited' },
  passwordHash: { type: String, select: false },
  authTokenHash: { type: String, select: false },
  authTokenExpires: Date,
  tokenVersion: { type: Number, default: 0 },
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionUser' },
}, { timestamps: true });
InstitutionUserSchema.index({ institutionId: 1, email: 1 }, { unique: true });
module.exports = mongoose.models.InstitutionUser || mongoose.model('InstitutionUser', InstitutionUserSchema);
