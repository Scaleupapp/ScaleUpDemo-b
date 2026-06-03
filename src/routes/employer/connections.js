// src/routes/employer/connections.js
'use strict';
const router = require('express').Router();
const featureFlags = require('../../config/featureFlags');
const { employerAuth, requireContactTier } = require('../../middleware/employerAuth');
const svc = require('../../services/employer/connectionService');

function flagGuard(req, res, next) {
  if (!featureFlags.employerMarketplace) return res.status(404).json({ success: false, message: 'Not found' });
  return next();
}

async function interestHandler(req, res) {
  try {
    const out = await module.exports._svc.expressInterest(req.employer.employerId, req.params.id, req.body || {});
    return res.status(200).json({ success: true, data: { connectionId: String(out._id), status: out.status } });
  } catch (err) {
    if (err.message === 'PROFILE_UNAVAILABLE') return res.status(404).json({ success: false, code: 'PROFILE_UNAVAILABLE', message: 'This candidate is no longer available.' });
    console.error('[employer/interest]', err.message);
    return res.status(500).json({ success: false, message: 'Could not send interest.' });
  }
}
async function listHandler(req, res) {
  try { return res.status(200).json({ success: true, data: await module.exports._svc.listForEmployer(req.employer.employerId) }); }
  catch (err) { console.error('[employer/connections]', err.message); return res.status(500).json({ success: false, message: 'Could not load.' }); }
}

router.post('/candidates/:id/interest', flagGuard, employerAuth, requireContactTier, interestHandler);
router.get('/connections', flagGuard, employerAuth, listHandler);

module.exports = router;
module.exports.interestHandler = interestHandler;
module.exports.listHandler = listHandler;
module.exports.flagGuard = flagGuard;
module.exports._svc = svc;
