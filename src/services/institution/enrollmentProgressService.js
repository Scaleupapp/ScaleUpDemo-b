'use strict';
// Institutional enrollment progress transitions.
//
// Additive + best-effort: these only affect institution (placement) students.
// A D2C user has no InstitutionEnrollment, so every call is a harmless no-op —
// callers wrap invocations in try/catch so this never breaks the shared D2C
// diagnostic/plan flow.

/**
 * Advance a student's cohort enrollment to 'diagnostic_done' when they finish
 * the diagnostic. Only moves enrollments currently at 'registered' (idempotent:
 * 'diagnostic_done'/'active'/'withdrawn' are left untouched, so re-runs and
 * recalibrations don't regress status). Returns the update result, or null.
 */
async function markDiagnosticDone(userId, deps = {}) {
  if (!userId) return null;
  const InstitutionEnrollment = deps.InstitutionEnrollment || require('../../models/InstitutionEnrollment');
  return InstitutionEnrollment.updateMany(
    { userId, status: 'registered' },
    { $set: { status: 'diagnostic_done' } }
  );
}

module.exports = { markDiagnosticDone };
