// src/services/employer/marketplaceAuditService.js
'use strict';

async function _write(doc) {
  const MarketplaceAuditLog = require('../../models/MarketplaceAuditLog');
  return MarketplaceAuditLog.create(doc);
}
async function _safe(doc) {
  try { await module.exports._write(doc); }
  catch (e) { console.warn('[marketplace-audit] write failed:', e.message); }
}

function logView({ employerId, talentProfileId }) {
  return _safe({ kind: 'view', actorType: 'employer', actorId: employerId, talentProfileId });
}
function logInterest({ employerId, candidateUserId, talentProfileId, connectionId }) {
  return _safe({ kind: 'interest', actorType: 'employer', actorId: employerId, subjectUserId: candidateUserId, talentProfileId, connectionId });
}
function logReveal({ employerId, candidateUserId, connectionId }) {
  return _safe({ kind: 'reveal', actorType: 'employer', actorId: employerId, subjectUserId: candidateUserId, connectionId });
}

module.exports = { logView, logInterest, logReveal, _write };
