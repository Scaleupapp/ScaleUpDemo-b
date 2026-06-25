'use strict';
// Resolves which experience a user sees: 'general' (D2C) or 'placement' (college).
//
// Placement accounts are DEDICATED — a roster email is a placement-only account
// (a registered email can't be put on a roster), so there's no dual-context case:
// an enrollment means placement, full stop. (The earlier dual-context switcher was
// removed when the product moved to dedicated placement accounts.)
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
