const mongoose = require('mongoose');
const InstitutionCohortSchema = new mongoose.Schema({
  institutionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
  departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true },
  year: { type: String, enum: ['final', 'pre_final'], required: true },
  label: { type: String, required: true },
  objectiveTemplateId: { type: mongoose.Schema.Types.ObjectId, ref: 'ObjectiveTemplate' },
  placementSeason: { startDate: Date, endDate: Date },
  status: { type: String, enum: ['setup', 'active', 'archived'], default: 'setup' },
}, { timestamps: true });
InstitutionCohortSchema.index({ institutionId: 1, departmentId: 1, year: 1 });
module.exports = mongoose.models.InstitutionCohort || mongoose.model('InstitutionCohort', InstitutionCohortSchema);
