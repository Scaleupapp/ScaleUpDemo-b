// src/routes/v2/talent.js
'use strict';
const router = require('express').Router();
const auth = require('../../middleware/auth');
const svc = require('../../services/employer/talentProfileService');
const featureFlags = require('../../config/featureFlags');

// Fix 4: feature-flag guard — routes are inert until FEATURE_EMPLOYER_MARKETPLACE is on
function flagGuard(req, res, next) {
  if (!featureFlags.employerMarketplace) return res.status(404).json({ success: false, message: 'Not found' });
  return next();
}

// exported for unit tests; routes call these
async function optInHandler(req, res) {
  try {
    const out = await svc.optIn(req.user.userId, req.body || {});
    return res.status(200).json({ success: true, data: out });
  } catch (err) {
    if (err.message === 'NO_OBJECTIVE') return res.status(400).json({ success: false, code: 'NO_OBJECTIVE', message: 'Set up a goal first.' });
    if (err.message === 'NOT_ELIGIBLE') return res.status(400).json({ success: false, code: 'NOT_ELIGIBLE', message: "You're not eligible for the talent pool yet — keep building evidence on a career goal." });
    // Fix 2: surface NO_SNAPSHOT as 400 instead of falling to 500
    if (err.message === 'NO_SNAPSHOT') return res.status(400).json({ success: false, code: 'NO_SNAPSHOT', message: 'Complete at least one assessment before joining the talent pool.' });
    console.error('[talent/opt-in]', err.message);
    return res.status(500).json({ success: false, message: 'Could not opt in.' });
  }
}
async function optOutHandler(req, res) {
  try { return res.status(200).json({ success: true, data: await svc.optOut(req.user.userId) }); }
  catch (err) { console.error('[talent/opt-out]', err.message); return res.status(500).json({ success: false, message: 'Could not opt out.' }); }
}
async function getHandler(req, res) {
  try {
    const TalentProfile = require('../../models/TalentProfile');
    const UserObjective = require('../../models/UserObjective');
    const obj = await UserObjective.findOne({ userId: req.user.userId, status: 'active', isPrimary: true }).select('_id').lean();
    const profile = obj ? await TalentProfile.findOne({ userId: req.user.userId, objectiveId: obj._id }).lean() : null;
    return res.status(200).json({ success: true, data: { optedIn: !!profile?.optedIn, profile: profile || null } });
  } catch (err) { console.error('[talent/get]', err.message); return res.status(500).json({ success: false, message: 'Could not load.' }); }
}
async function patchHandler(req, res) {
  try {
    const TalentProfile = require('../../models/TalentProfile');
    const UserObjective = require('../../models/UserObjective');
    const obj = await UserObjective.findOne({ userId: req.user.userId, status: 'active', isPrimary: true }).select('_id').lean();
    if (!obj) return res.status(400).json({ success: false, code: 'NO_OBJECTIVE', message: 'No active goal.' });
    const { city, noticePeriod, workPref } = req.body || {};
    const set = {};
    if (city != null) set.city = city;
    if (noticePeriod != null) set.noticePeriod = noticePeriod;
    if (workPref != null) set.workPref = workPref;
    // Fix 6: update-only, no upsert — prevent ghost profiles for users who never opted in
    const r = await TalentProfile.updateOne({ userId: req.user.userId, objectiveId: obj._id, optedIn: true }, { $set: set });
    if (!r.matchedCount) return res.status(400).json({ success: false, code: 'NO_PROFILE', message: 'Join the talent pool first.' });
    return res.status(200).json({ success: true, data: { ok: true } });
  } catch (err) { console.error('[talent/patch]', err.message); return res.status(500).json({ success: false, message: 'Could not update.' }); }
}

// Fix 4: flagGuard is the FIRST middleware on all four routes
router.get('/', flagGuard, auth, getHandler);
router.post('/opt-in', flagGuard, auth, optInHandler);
router.post('/opt-out', flagGuard, auth, optOutHandler);
router.patch('/', flagGuard, auth, patchHandler);

// Fix 5: keep only module.exports._svc (module.exports === router, so router._svc was redundant)
module.exports = router;
module.exports.optInHandler = optInHandler;
module.exports.optOutHandler = optOutHandler;
module.exports.getHandler = getHandler;
module.exports.patchHandler = patchHandler;
module.exports._svc = svc;
module.exports.flagGuard = flagGuard;
