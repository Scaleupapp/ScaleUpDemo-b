'use strict';
const crypto = require('crypto');
async function commitRoster({ rosterUpload, validRows, deps = {} }) {
  const PendingStudent = deps.PendingStudent || require('../../models/PendingStudent');
  const randomToken = deps.randomToken || (() => crypto.randomBytes(16).toString('hex'));
  const pending = [];
  for (const row of validRows) {
    pending.push(await PendingStudent.create({
      institutionId: rosterUpload.institutionId, departmentId: rosterUpload.departmentId, cohortId: rosterUpload.cohortId,
      rosterUploadId: rosterUpload._id, name: row.name, rollNumber: row.rollNumber, email: row.email, phone: row.phone,
      inviteToken: randomToken(), status: 'pending',
    }));
  }
  rosterUpload.status = 'committed';
  await rosterUpload.save();
  return { created: pending.length, pending };
}
module.exports = { commitRoster };
