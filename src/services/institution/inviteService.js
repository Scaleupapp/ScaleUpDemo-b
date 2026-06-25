'use strict';

async function sendInvites(pendingList = [], { institutionName, baseLink, deps = {} } = {}) {
  const email = deps.email || require('../emailService');
  const sendSMS = deps.sendSMS || require('../../utils/sendSMS');
  let invited = 0;
  const failures = [];

  for (const p of pendingList) {
    const link = `${baseLink}?token=${p.inviteToken}`;
    try {
      if (p.email) await email.sendStudentInvite(p.email, { studentName: p.name, institutionName, link, code: p.claimCode });
      if (p.phone) await sendSMS(p.phone, `${institutionName} invited you to ScaleUp Placements. Your join code: ${p.claimCode}. Details: ${link}`);
      p.status = 'invited';
      await p.save();
      invited += 1;
    } catch (e) {
      failures.push({ to: p.email || p.phone, error: e.message });
    }
  }

  return { invited, failures };
}

module.exports = { sendInvites };
