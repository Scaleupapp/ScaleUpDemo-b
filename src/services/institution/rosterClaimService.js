'use strict';
function digits(s) { return String(s || '').replace(/\D/g, ''); }
async function claimForUser(user, deps = {}) {
  if (!user) return null;
  const PendingStudent = deps.PendingStudent || require('../../models/PendingStudent');
  const InstitutionEnrollment = deps.InstitutionEnrollment || require('../../models/InstitutionEnrollment');
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
  return enrollment;
}
module.exports = { claimForUser };
