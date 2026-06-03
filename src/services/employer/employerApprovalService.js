// src/services/employer/employerApprovalService.js
'use strict';

async function _update(employerId, patch) {
  const EmployerAccount = require('../../models/EmployerAccount');
  return EmployerAccount.findByIdAndUpdate(employerId, { $set: patch }, { new: true });
}
async function listPending() {
  const EmployerAccount = require('../../models/EmployerAccount');
  return EmployerAccount.find({ approvalStatus: 'pending', emailVerified: true })
    .select('email companyName name title linkedIn createdAt').sort({ createdAt: 1 }).lean();
}
async function approve(employerId, adminUserId) {
  return module.exports._update(employerId, { approvalStatus: 'approved', approvedBy: adminUserId, approvedAt: new Date() });
}
async function reject(employerId, adminUserId) {
  return module.exports._update(employerId, { approvalStatus: 'rejected', approvedBy: adminUserId, approvedAt: new Date() });
}

module.exports = { listPending, approve, reject, _update };
