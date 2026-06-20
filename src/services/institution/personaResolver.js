'use strict';
async function resolvePersona(userId, deps = {}) {
  const Enrollment = deps.Enrollment || require('../../models/InstitutionEnrollment');
  const enrollment = await Enrollment
    .findOne({ userId, status: { $in: ['registered', 'diagnostic_done', 'active'] } })
    .populate('institutionId cohortId');
  if (!enrollment) return { persona: 'general' };
  const inst = enrollment.institutionId, cohort = enrollment.cohortId;
  return {
    persona: 'placement',
    placement: {
      institution: { id: String(inst._id), name: inst.name, logoUrl: inst.logoUrl, brandColor: inst.brandColor },
      cohort: { id: String(cohort._id), year: cohort.year, label: cohort.label },
      placementSeason: { deadline: cohort.placementSeason?.endDate ?? null },
      objective: { locked: true },
    },
  };
}
module.exports = { resolvePersona };
