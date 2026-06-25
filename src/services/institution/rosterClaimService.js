'use strict';

// Shared enrollment: given a resolved PendingStudent + the user, create the
// InstitutionEnrollment, mark the pending claimed, backfill the name, and seed
// the locked institutional objective. Used by both claim paths (email auto-match
// and 6-digit code redemption). Idempotent per (institution, user).
async function enrollPending(user, pending, deps = {}) {
  const InstitutionEnrollment = deps.InstitutionEnrollment || require('../../models/InstitutionEnrollment');
  const User = deps.User || require('../../models/User');
  const objectiveBindingService = deps.objectiveBindingService || require('./objectiveBindingService');

  const existing = await InstitutionEnrollment.findOne({ institutionId: pending.institutionId, userId: user._id });
  if (existing) return existing;
  const enrollment = await InstitutionEnrollment.create({
    institutionId: pending.institutionId, departmentId: pending.departmentId, cohortId: pending.cohortId,
    userId: user._id, pendingStudentId: pending._id, rollNumber: pending.rollNumber, status: 'registered', joinedAt: new Date(),
  });
  pending.status = 'claimed'; pending.matchedUserId = user._id; await pending.save();
  // Backfill the student's profile name from the roster (the college already
  // provided it) — only when the user has no real name yet, so we never clobber
  // a name the student set themselves. Best-effort; never blocks the claim.
  try {
    const current = String(user.firstName || '').trim();
    if (pending.name && (current === '' || current.toLowerCase() === 'unknown')) {
      const parts = String(pending.name).trim().split(/\s+/);
      const firstName = parts[0];
      const lastName = parts.slice(1).join(' ');
      await User.updateOne(
        { _id: user._id },
        { $set: { firstName, ...(lastName ? { lastName } : {}) } }
      );
    }
  } catch (e) {
    console.warn('[claim] name backfill failed', e.message);
  }
  // Seed the locked institutional objective from the cohort's template (best-effort).
  // claimForUser is awaited inline on the signup/login path, so we cap the wait: a
  // slow/hung seed keeps running in the background while the claim returns promptly.
  // A missing template is a no-op; a failure must never block the claim.
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

// Auto-match on signup/login: EMAIL is the identity anchor (a phone number can
// never claim a roster spot — reassignable/typo-prone). Returns null for a pure
// D2C user (no matching roster row), so it's a safe no-op on every auth path.
async function claimForUser(user, deps = {}) {
  if (!user) return null;
  const PendingStudent = deps.PendingStudent || require('../../models/PendingStudent');
  const email = (user.email || '').toLowerCase();
  if (!email) return null;
  const pending = await PendingStudent.findOne({ status: { $in: ['pending', 'invited'] }, email });
  if (!pending) return null;
  return enrollPending(user, pending, deps);
}

// Manual claim by the 6-digit code printed in the invite. Works even when the
// student's app email differs from the roster email. Returns null on a bad/used code.
async function claimByCode(user, code, deps = {}) {
  if (!user) return null;
  const PendingStudent = deps.PendingStudent || require('../../models/PendingStudent');
  const normalized = String(code || '').replace(/\D/g, '');
  if (normalized.length !== 6) return null;
  const pending = await PendingStudent.findOne({ status: { $in: ['pending', 'invited'] }, claimCode: normalized });
  if (!pending) return null;
  return enrollPending(user, pending, deps);
}

module.exports = { claimForUser, claimByCode, enrollPending };
