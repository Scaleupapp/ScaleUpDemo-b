// src/services/employer/marketplaceNotificationService.js
'use strict';

async function _sendToUser(userId, payload) {
  const notificationService = require('../notificationService');
  return notificationService.sendToUser(userId, payload);
}
async function _loadEmployerEmail(employerId) {
  const EmployerAccount = require('../../models/EmployerAccount');
  const acc = await EmployerAccount.findById(employerId).select('email').lean();
  return acc ? acc.email : null;
}
async function _sendEmail(to, subject, body) {
  // PILOT: log. Replace with a real mailer alongside the employer magic-link mailer.
  console.log(`[marketplace-email] to=${to} subject="${subject}"`);
  return true;
}

// Candidate gets a push when an employer is interested — employer identity stays masked.
async function notifyCandidateOfInterest(candidateUserId, { roleContext } = {}) {
  try {
    const role = roleContext ? ` for ${roleContext}` : '';
    await module.exports._sendToUser(candidateUserId, {
      title: 'A verified employer is interested',
      body: `An employer wants to connect${role}. Review and approve in your inbox.`,
      data: { type: 'marketplace_interest', deepLink: 'scaleup://talent/connections' },
    });
  } catch (e) { console.warn('[marketplace-notify] candidate push failed:', e.message); }
}

// Employer gets an email when a candidate approves (sign in to see the reveal).
async function notifyEmployerOfApproval(employerId, { connectionId } = {}) {
  try {
    const email = await module.exports._loadEmployerEmail(employerId);
    if (!email) return;
    await module.exports._sendEmail(email, 'A candidate accepted your interest',
      'Good news — a candidate approved your connection. Sign in to ScaleUp Hire to see their details and reach out.');
  } catch (e) { console.warn('[marketplace-notify] employer email failed:', e.message); }
}

module.exports = { notifyCandidateOfInterest, notifyEmployerOfApproval, _sendToUser, _loadEmployerEmail, _sendEmail };
