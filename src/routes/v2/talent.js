// src/routes/v2/talent.js
'use strict';
const router = require('express').Router();
const auth = require('../../middleware/auth');
const svc = require('../../services/employer/talentProfileService');

// exported for unit tests; routes call these
async function optInHandler(req, res) {
  try {
    const out = await svc.optIn(req.user.userId, req.body || {});
    return res.status(200).json({ success: true, data: out });
  } catch (err) {
    if (err.message === 'NO_OBJECTIVE') return res.status(400).json({ success: false, code: 'NO_OBJECTIVE', message: 'Set up a goal first.' });
    if (err.message === 'NOT_ELIGIBLE') return res.status(400).json({ success: false, code: 'NOT_ELIGIBLE', message: "You're not eligible for the talent pool yet — keep building evidence on a career goal." });
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
    const UserObjective = require('../../models/UserObjective');
    const obj = await UserObjective.findOne({ userId: req.user.userId, status: 'active', isPrimary: true }).select('_id').lean();
    if (!obj) return res.status(400).json({ success: false, code: 'NO_OBJECTIVE', message: 'No active goal.' });
    const { city, noticePeriod, workPref } = req.body || {};
    const set = {};
    if (city != null) set.city = city;
    if (noticePeriod != null) set.noticePeriod = noticePeriod;
    if (workPref != null) set.workPref = workPref;
    await svc._upsertProfile(req.user.userId, obj._id, set);
    return res.status(200).json({ success: true, data: { ok: true } });
  } catch (err) { console.error('[talent/patch]', err.message); return res.status(500).json({ success: false, message: 'Could not update.' }); }
}

router.get('/', auth, getHandler);
router.post('/opt-in', auth, optInHandler);
router.post('/opt-out', auth, optOutHandler);
router.patch('/', auth, patchHandler);

// test seam
router._svc = svc;
module.exports = router;
module.exports.optInHandler = optInHandler;
module.exports.optOutHandler = optOutHandler;
module.exports.getHandler = getHandler;
module.exports.patchHandler = patchHandler;
module.exports._svc = svc;
