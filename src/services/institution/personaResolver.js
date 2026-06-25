'use strict';
// Resolves which experience a user sees: 'general' (D2C) or 'placement' (college).
//
// Three cases:
//   1. No college enrollment            → 'general'   (pure D2C — UNCHANGED).
//   2. Enrolled, no personal objective  → 'placement' (pure placement student — UNCHANGED).
//   3. Enrolled AND has a personal       → DUAL: honour User.preferredContext;
//      (non-institutional) objective        if unset, flag needsContextChoice so the
//                                            client shows the one-time chooser.
//
// Cases 1 & 2 are byte-for-byte the old behaviour, so non-dual users are
// unaffected. Only a dual-context user reaches the preference logic.
async function resolvePersona(userId, deps = {}) {
  const Enrollment = deps.Enrollment || require('../../models/InstitutionEnrollment');
  const UserObjective = deps.UserObjective || require('../../models/UserObjective');
  const User = deps.User || require('../../models/User');

  const enrollment = await Enrollment
    .findOne({ userId, status: { $in: ['registered', 'diagnostic_done', 'active'] } })
    .populate('institutionId cohortId');

  // Case 1 — pure D2C user. Unchanged.
  if (!enrollment) return { persona: 'general' };

  const inst = enrollment.institutionId, cohort = enrollment.cohortId;
  const placement = {
    institution: { id: String(inst._id), name: inst.name, logoUrl: inst.logoUrl, brandColor: inst.brandColor },
    cohort: { id: String(cohort._id), year: cohort.year, label: cohort.label },
    placementSeason: { deadline: cohort.placementSeason?.endDate ?? null },
    objective: { locked: true },
  };

  // A "personal" objective is any active objective that is NOT the locked
  // institutional one (institutionContext.locked !== true also matches objectives
  // that have no institutionContext at all — the normal D2C goal).
  const personalObjective = await UserObjective.findOne({
    userId,
    status: 'active',
    'institutionContext.locked': { $ne: true },
  }).select('_id');

  // Case 2 — pure placement student (no personal goal). Unchanged.
  if (!personalObjective) return { persona: 'placement', placement };

  // Case 3 — dual-context. Let the user choose; remember the choice.
  const user = await User.findById(userId).select('preferredContext');
  const preferred = user && user.preferredContext ? user.preferredContext : null;
  const availableContexts = ['placement', 'personal'];

  if (!preferred) {
    // Not chosen yet — client shows the chooser. Default backdrop is placement
    // (the enrollment exists), but needsContextChoice tells the client to ask.
    return { persona: 'placement', needsContextChoice: true, availableContexts, placement };
  }
  if (preferred === 'personal') {
    return { persona: 'general', activeContext: 'personal', availableContexts, placement };
  }
  return { persona: 'placement', activeContext: 'placement', availableContexts, placement };
}
module.exports = { resolvePersona };
