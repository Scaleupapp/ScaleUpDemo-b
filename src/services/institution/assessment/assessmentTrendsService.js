'use strict';
// Trend analytics for per-assessment rollups: time-ordered series and
// cross-cohort comparison. Fully deps-injectable — no real DB in tests.

/**
 * Average byCompetency entries across multiple rollups.
 * Groups by name, computes weighted-average avgScore (Math.round),
 * accumulates total n, and returns the result sorted by name.
 *
 * @param {Array} rollups
 * @returns {Array<{name:string, avgScore:number, n:number}>}
 */
function averagedByCompetency(rollups) {
  const acc = {}; // name -> { sumWeighted, totalN }

  for (const rollup of rollups) {
    const entries = rollup.byCompetency || [];
    for (const entry of entries) {
      const name = entry.name;
      if (!acc[name]) acc[name] = { sumWeighted: 0, totalN: 0 };
      acc[name].sumWeighted += (entry.avgScore || 0) * (entry.n || 0);
      acc[name].totalN += entry.n || 0;
    }
  }

  return Object.keys(acc)
    .sort()
    .map((name) => ({
      name,
      avgScore: acc[name].totalN ? Math.round(acc[name].sumWeighted / acc[name].totalN) : null,
      n: acc[name].totalN,
    }));
}

/**
 * Build a time-ordered trend series for a cohort across all per-assessment rollups.
 *
 * @param {string} cohortId
 * @param {object} deps
 * @returns {Promise<Array>}
 */
async function buildTrends(cohortId, deps) {
  const CohortRollup = deps.CohortRollup || require('../../../models/CohortRollup');
  const Assessment = deps.Assessment || require('../../../models/Assessment');

  const rollups = await CohortRollup.find({ cohortId, assessmentId: { $ne: null } });

  const items = [];

  for (const rollup of rollups) {
    const assessment = await Assessment.findById(rollup.assessmentId);
    if (!assessment) continue; // assessment deleted — skip

    const at = assessment.closedAt || assessment.closesAt || rollup.computedAt;

    items.push({
      assessmentId: rollup.assessmentId,
      title: assessment.title,
      type: assessment.type,
      at,
      avgScore: rollup.avgScore,
      graded: rollup.counts.graded,
      byCompetency: rollup.byCompetency,
    });
  }

  // Sort ascending by at (Date)
  items.sort((a, b) => new Date(a.at) - new Date(b.at));

  return items;
}

/**
 * Build a cross-cohort comparison for a given institution.
 *
 * @param {string} institutionId
 * @param {string[]} cohortIds  — capped at 10
 * @param {object} deps
 * @returns {Promise<Array>}
 */
async function buildComparison(institutionId, cohortIds, deps) {
  const InstitutionCohort = deps.InstitutionCohort || require('../../../models/InstitutionCohort');
  const CohortRollup = deps.CohortRollup || require('../../../models/CohortRollup');

  // Cap at 10
  const cappedIds = cohortIds.slice(0, 10);

  // Only cohorts that actually belong to this institution
  const validCohorts = await InstitutionCohort.find({
    institutionId,
    _id: { $in: cappedIds },
  });

  const results = [];

  for (const cohort of validCohorts) {
    const rollups = await CohortRollup.find({
      cohortId: cohort._id,
      assessmentId: { $ne: null },
    });

    const assessmentsGraded = rollups.length;
    const avgScore = assessmentsGraded
      ? Math.round(rollups.reduce((s, r) => s + (r.avgScore || 0), 0) / assessmentsGraded)
      : null;

    results.push({
      cohortId: String(cohort._id),
      label: cohort.label,
      assessmentsGraded,
      avgScore,
      byCompetency: averagedByCompetency(rollups),
    });
  }

  return results;
}

module.exports = { buildTrends, buildComparison };
