'use strict';
const crypto = require('crypto');

// A 6-digit code, unique among students not yet claimed. Best-effort uniqueness:
// 1M space, a handful of retries; falls back to a random code if the (very
// unlikely) collisions persist or the uniqueness probe isn't available (tests).
async function generateClaimCode(PendingStudent) {
  const make = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  for (let i = 0; i < 20; i++) {
    const code = make();
    try {
      const clash = await PendingStudent.findOne({ claimCode: code, status: { $in: ['pending', 'invited'] } });
      if (!clash) return code;
    } catch {
      return code; // no probe available (e.g. stubbed model in tests)
    }
  }
  return make();
}

async function commitRoster({ rosterUpload, validRows, deps = {} }) {
  const PendingStudent = deps.PendingStudent || require('../../models/PendingStudent');
  const randomToken = deps.randomToken || (() => crypto.randomBytes(16).toString('hex'));
  const pending = [];
  for (const row of validRows) {
    const claimCode = await generateClaimCode(PendingStudent);
    pending.push(await PendingStudent.create({
      institutionId: rosterUpload.institutionId, departmentId: rosterUpload.departmentId, cohortId: rosterUpload.cohortId,
      rosterUploadId: rosterUpload._id, name: row.name, rollNumber: row.rollNumber, email: row.email, phone: row.phone,
      inviteToken: randomToken(), claimCode, status: 'pending',
    }));
  }
  rosterUpload.status = 'committed';
  await rosterUpload.save();
  return { created: pending.length, pending };
}
module.exports = { commitRoster, generateClaimCode };
