'use strict';
// Recompute + upsert the cached analytics rollup for an assessment (and the
// cohort-wide rollup). Pure aggregation over AssessmentSession; safe to re-run.
async function recompute(institutionId, cohortId, assessmentId, deps = {}) {
  const AssessmentSession = deps.AssessmentSession || require('../../../models/AssessmentSession');
  const CohortRollup = deps.CohortRollup || require('../../../models/CohortRollup');

  const sessions = await AssessmentSession.find({ institutionId, cohortId, assessmentId });
  const graded = sessions.filter((s) => s.status === 'graded');
  const scores = graded.map((s) => s.result && s.result.score).filter((n) => typeof n === 'number');
  const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : undefined;
  const integrityFlags = graded.filter((s) => s.result && ['low', 'suspicious', 'minor_flags'].includes(s.result.integrity)).length;

  const counts = {
    assigned: sessions.length,
    started: sessions.filter((s) => s.status !== 'scheduled').length,
    submitted: sessions.filter((s) => ['submitted', 'graded'].includes(s.status)).length,
    graded: graded.length,
  };

  const doc = {
    institutionId, cohortId, assessmentId,
    computedAt: (deps.now && deps.now()) || new Date(),
    counts, avgScore, integrityFlags, byCompetency: [],
  };
  await CohortRollup.findOneAndUpdate(
    { institutionId, cohortId, assessmentId },
    { $set: doc },
    { upsert: true, new: true },
  );
  return doc;
}

module.exports = { recompute };
