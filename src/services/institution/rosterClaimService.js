'use strict';
function digits(s) { return String(s || '').replace(/\D/g, ''); }
async function claimForUser(user, deps = {}) {
  if (!user) return null;
  const PendingStudent = deps.PendingStudent || require('../../models/PendingStudent');
  const InstitutionEnrollment = deps.InstitutionEnrollment || require('../../models/InstitutionEnrollment');
  const objectiveBindingService = deps.objectiveBindingService || require('./objectiveBindingService');
  const email = (user.email || '').toLowerCase();
  const phoneDigits = digits(user.phone);
  const or = [];
  if (email) or.push({ email });
  if (phoneDigits) or.push({ phone: new RegExp(phoneDigits + '$') });
  if (!or.length) return null;
  const pending = await PendingStudent.findOne({ status: { $in: ['pending', 'invited'] }, $or: or });
  if (!pending) return null;
  const existing = await InstitutionEnrollment.findOne({ institutionId: pending.institutionId, userId: user._id });
  if (existing) return existing;
  const enrollment = await InstitutionEnrollment.create({
    institutionId: pending.institutionId, departmentId: pending.departmentId, cohortId: pending.cohortId,
    userId: user._id, pendingStudentId: pending._id, rollNumber: pending.rollNumber, status: 'registered', joinedAt: new Date(),
  });
  pending.status = 'claimed'; pending.matchedUserId = user._id; await pending.save();
  // Seed the locked institutional objective from the cohort's template (best-effort).
  // This only runs for a matched (institutional) student — a pure D2C user returns
  // above and never reaches here. Even so, claimForUser is awaited inline on the
  // signup/login path, so we cap the wait: a slow/hung seed keeps running in the
  // background while the claim returns promptly. A missing template is a no-op;
  // a failure must never block the claim.
  const SEED_TIMEOUT_MS = Number(process.env.INSTITUTION_SEED_TIMEOUT_MS || 3000);
  const seedPromise = objectiveBindingService
    .seedObjectiveFromCohort(user._id, enrollment.cohortId, { assignedBy: null })
    .catch((e) => { console.warn('[claim] objective seed failed', e.message); });
  let seedTimer;
  await Promise.race([
    seedPromise,
    new Promise((resolve) => { seedTimer = setTimeout(resolve, SEED_TIMEOUT_MS); }),
  ]);
  clearTimeout(seedTimer);
  return enrollment;
}
module.exports = { claimForUser };
