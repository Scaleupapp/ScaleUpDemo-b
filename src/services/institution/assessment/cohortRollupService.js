'use strict';
// Recompute + upsert the cached analytics rollup for an assessment (and the
// cohort-wide rollup). Pure aggregation over AssessmentSession; safe to re-run.

function computeByCompetency(engineType, gradedSessions) {
  if (!engineType) return [];
  const acc = {}; // name -> { sum, n }
  for (const s of gradedSessions) {
    const raw = s.result && s.result.raw;
    if (!raw) continue;
    if (engineType === 'mcq') {
      const breakdown = raw.competencyBreakdown;
      if (!Array.isArray(breakdown)) continue;
      for (const entry of breakdown) {
        if (!entry || typeof entry.percentage !== 'number') continue;
        const name = entry.competency || 'unknown';
        if (!acc[name]) acc[name] = { sum: 0, n: 0 };
        acc[name].sum += entry.percentage;
        acc[name].n += 1;
      }
    } else if (engineType === 'interview') {
      const dims = raw.dimensions;
      if (!dims || typeof dims !== 'object') continue;
      for (const [dim, val] of Object.entries(dims)) {
        if (!val || typeof val.score !== 'number') continue;
        if (!acc[dim]) acc[dim] = { sum: 0, n: 0 };
        acc[dim].sum += val.score;
        acc[dim].n += 1;
      }
    } else if (engineType === 'capstone') {
      const dimScores = raw.dimension_scores;
      if (!dimScores || typeof dimScores !== 'object') continue;
      for (const [dim, val] of Object.entries(dimScores)) {
        if (typeof val !== 'number') continue;
        if (!acc[dim]) acc[dim] = { sum: 0, n: 0 };
        acc[dim].sum += val * 10; // scale 0-10 → 0-100
        acc[dim].n += 1;
      }
    } else if (engineType === 'drill') {
      const breakdown = raw.rubric_breakdown;
      if (!Array.isArray(breakdown)) continue;
      for (const entry of breakdown) {
        if (!entry || typeof entry.score !== 'number') continue;
        const name = entry.dimension || 'unknown';
        if (!acc[name]) acc[name] = { sum: 0, n: 0 };
        acc[name].sum += entry.score;
        acc[name].n += 1;
      }
    }
  }
  return Object.entries(acc).map(([name, { sum, n }]) => ({ name, avgScore: Math.round(sum / n), n }));
}

async function recompute(institutionId, cohortId, assessmentId, deps = {}) {
  const AssessmentSession = deps.AssessmentSession || require('../../../models/AssessmentSession');
  const CohortRollup = deps.CohortRollup || require('../../../models/CohortRollup');
  const InstitutionEnrollment = deps.InstitutionEnrollment || require('../../../models/InstitutionEnrollment');

  const sessions = await AssessmentSession.find({ institutionId, cohortId, assessmentId });
  const graded = sessions.filter((s) => s.status === 'graded');
  const scores = graded.map((s) => s.result && s.result.score).filter((n) => typeof n === 'number');
  const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : undefined;
  const integrityFlags = graded.filter((s) => s.result && ['low', 'suspicious', 'minor_flags'].includes(s.result.integrity)).length;

  // Sub-feature A: assigned = cohort enrollment count (not session count)
  const assigned = await InstitutionEnrollment.countDocuments({ cohortId, status: { $ne: 'withdrawn' } });

  // Honest lifecycle buckets (Wave 3 block 2). submitted = reached submission
  // (submitted OR graded) — now backed by a real submittedAt, no longer a
  // fabricated mirror of graded. expired is its own distinct terminal bucket.
  const counts = {
    assigned,
    started: sessions.filter((s) => s.status !== 'scheduled').length,
    submitted: sessions.filter((s) => ['submitted', 'graded'].includes(s.status)).length,
    graded: graded.length,
    expired: sessions.filter((s) => s.status === 'expired').length,
  };

  // Sub-feature B: byCompetency populated from graded sessions
  const engineType = graded.length > 0 && graded[0].engine ? graded[0].engine.type : undefined;
  const byCompetency = computeByCompetency(engineType, graded);

  const doc = {
    institutionId, cohortId, assessmentId,
    computedAt: (deps.now && deps.now()) || new Date(),
    counts, avgScore, gradedCount: scores.length, integrityFlags, byCompetency,
  };
  await CohortRollup.findOneAndUpdate(
    { institutionId, cohortId, assessmentId },
    { $set: doc },
    { upsert: true, new: true },
  );
  return doc;
}

module.exports = { recompute };
