// src/routes/v2/talentConnections.js
'use strict';
const router = require('express').Router();
const featureFlags = require('../../config/featureFlags');
const auth = require('../../middleware/auth');
const svc = require('../../services/employer/connectionService');

function flagGuard(req, res, next) {
  if (!featureFlags.employerMarketplace) return res.status(404).json({ success: false, message: 'Not found' });
  return next();
}

async function inboxHandler(req, res) {
  try { return res.status(200).json({ success: true, data: await module.exports._svc.listForCandidate(req.user.userId) }); }
  catch (err) { console.error('[talent/connections]', err.message); return res.status(500).json({ success: false, message: 'Could not load.' }); }
}
function _respondHandler(decision) {
  return async function (req, res) {
    try {
      const out = await module.exports._svc.respond(req.params.id, req.user.userId, decision);
      return res.status(200).json({ success: true, data: { connectionId: String(out._id), status: out.status } });
    } catch (err) {
      if (err.message === 'NOT_FOUND') return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Request not found.' });
      if (err.message === 'ALREADY_RESPONDED') return res.status(409).json({ success: false, code: 'ALREADY_RESPONDED', message: 'You already responded to this.' });
      console.error('[talent/respond]', err.message);
      return res.status(500).json({ success: false, message: 'Could not respond.' });
    }
  };
}
const approveHandler = _respondHandler('approved');
const declineHandler = _respondHandler('declined');

router.get('/', flagGuard, auth, inboxHandler);
router.post('/:id/approve', flagGuard, auth, approveHandler);
router.post('/:id/decline', flagGuard, auth, declineHandler);

module.exports = router;
module.exports.inboxHandler = inboxHandler;
module.exports.approveHandler = approveHandler;
module.exports.declineHandler = declineHandler;
module.exports.flagGuard = flagGuard;
module.exports._svc = svc;
