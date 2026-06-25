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
  // An enrollment means placement, full stop. Guard the populate: if the
  // institution/cohort ref can't be loaded, STILL return placement with safe
  // defaults — never throw (a 500 here would make the client fall back to the
  // D2C/general experience and re-run the generic onboarding for a placement
  // student, which is exactly the failure we must avoid).
  const inst = enrollment.institutionId || {};
  const cohort = enrollment.cohortId || {};
  return {
    persona: 'placement',
    placement: {
      institution: {
        id: inst._id ? String(inst._id) : String(enrollment.institutionId || ''),
        name: inst.name || 'Your college',
        logoUrl: inst.logoUrl ?? null,
        brandColor: inst.brandColor ?? null,
      },
      cohort: {
        id: cohort._id ? String(cohort._id) : String(enrollment.cohortId || ''),
        year: cohort.year || '',
        label: cohort.label || '',
      },
      placementSeason: { deadline: cohort.placementSeason?.endDate ?? null },
      objective: { locked: true },
    },
  };
}
module.exports = { resolvePersona };
