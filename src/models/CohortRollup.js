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
    // Wave 3 block 2: distinct honest bucket — ran out of time, never graded.
    expired: { type: Number, default: 0 },
  },
  avgScore: Number,
  // Wave 3 block 2: how many graded sessions avgScore is the mean of, so a UI
  // can label "avg of N graded" instead of implying the whole cohort.
  gradedCount: { type: Number, default: 0 },
  // Wave 3 block 4: per-engine score framing ('objective' | 'ai_judged' |
  // 'mixed' on the cohort-wide rollup) so UIs never cross-average.
  scoreMethod: { type: String },
  // Wave 3 block 4: honest integrity accounting. integrityFlags kept for
  // backward-compat but now == integrity.flaggedCount (real flags only).
  integrity: {
    checkedCount: { type: Number, default: 0 },
    flaggedCount: { type: Number, default: 0 },
    unproctoredCount: { type: Number, default: 0 },
  },
  integrityFlags: { type: Number, default: 0 },
  byCompetency: [{ name: String, avgScore: Number, n: Number }],
}, { timestamps: true });

CohortRollupSchema.index({ institutionId: 1, cohortId: 1, assessmentId: 1 });

module.exports = mongoose.models.CohortRollup || mongoose.model('CohortRollup', CohortRollupSchema);
