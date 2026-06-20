const mongoose = require('mongoose');
const DepartmentSchema = new mongoose.Schema({
  institutionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true },
  name: { type: String, required: true },
  code: { type: String, required: true },
  capabilityTracks: [{ type: String, enum: ['fullstack_ai', 'software', 'database'] }],
}, { timestamps: true });
DepartmentSchema.index({ institutionId: 1, code: 1 }, { unique: true });
module.exports = mongoose.models.Department || mongoose.model('Department', DepartmentSchema);
