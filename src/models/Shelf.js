const mongoose = require('mongoose');
const ShelfSchema = new mongoose.Schema({
  institutionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
  cohortId: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionCohort', required: true, index: true },
  title: { type: String, required: true, trim: true },
  order: { type: Number, default: 0 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionUser' },
}, { timestamps: true });
ShelfSchema.index({ institutionId: 1, cohortId: 1, order: 1 });
module.exports = mongoose.models.Shelf || mongoose.model('Shelf', ShelfSchema);
