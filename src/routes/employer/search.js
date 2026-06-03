// src/routes/employer/search.js
'use strict';
const router = require('express').Router();
const featureFlags = require('../../config/featureFlags');
const { employerAuth } = require('../../middleware/employerAuth');
const svc = require('../../services/employer/employerSearchService');

function flagGuard(req, res, next) {
  if (!featureFlags.employerMarketplace) return res.status(404).json({ success: false, message: 'Not found' });
  return next();
}
function _csv(v) { return typeof v === 'string' && v.length ? v.split(',').map((x) => x.trim()).filter(Boolean) : []; }

async function searchHandler(req, res) {
  try {
    const q = req.query || {};
    const filters = {
      bands: _csv(q.bands), skills: _csv(q.skills),
      objectiveType: q.objectiveType || undefined, roleLabel: q.roleLabel || undefined,
      targetCompany: q.targetCompany || undefined, city: q.city || undefined,
      workPref: q.workPref || undefined, proof: q.proof || undefined,
    };
    const limit = q.limit ? parseInt(q.limit, 10) : undefined;
    return res.status(200).json({ success: true, data: await module.exports._svc.search(filters, { limit }) });
  } catch (err) { console.error('[employer/search]', err.message); return res.status(500).json({ success: false, message: 'Search failed.' }); }
}

async function candidateHandler(req, res) {
  try {
    const p = await module.exports._svc.getCandidate(req.params.id);
    if (!p) return res.status(404).json({ success: false, message: 'Candidate not found or no longer available.' });
    return res.status(200).json({ success: true, data: p });
  } catch (err) {
    console.error('[employer/candidate]', err.message);
    if (err.name === 'CastError') return res.status(400).json({ success: false, message: 'Invalid candidate id.' });
    return res.status(500).json({ success: false, message: 'Could not load candidate.' });
  }
}

router.get('/search', flagGuard, employerAuth, searchHandler);
router.get('/candidates/:id', flagGuard, employerAuth, candidateHandler);

module.exports = router;
module.exports.searchHandler = searchHandler;
module.exports.candidateHandler = candidateHandler;
module.exports.flagGuard = flagGuard;
module.exports._svc = svc;
