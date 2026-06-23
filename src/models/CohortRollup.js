const mongoose = require('mongoose');

const CohortRollupSchema = new mongoose.Schema({
  institutionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
  cohortId: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionCohort', required: true },
  assessmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Assessment' }, // null = cohort-wide
  computedAt: { type: Date, default: Date.now },
  counts: {
    assigned: { type: Number, default: 0 },
    started: { type: Number, default: 0 },
    submitted: { type: Number, default: 0 },
    graded: { type: Number, default: 0 },
  },
  avgScore: Number,
  integrityFlags: { type: Number, default: 0 },
  byCompetency: [{ name: String, avgScore: Number, n: Number }],
}, { timestamps: true });

CohortRollupSchema.index({ institutionId: 1, cohortId: 1, assessmentId: 1 });

module.exports = mongoose.models.CohortRollup || mongoose.model('CohortRollup', CohortRollupSchema);
