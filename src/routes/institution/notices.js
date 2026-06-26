'use strict';
const express = require('express');
const institutionAuth = require('../../middleware/institutionAuth');
const { institutionScope, requireInstitutionRole } = require('../../middleware/institutionScope');
const router = express.Router();
router._deps = null;
function getService(deps) { return (deps && deps.noticeService) || require('../../services/institution/noticeService'); }
const WRITE = requireInstitutionRole('institution_admin', 'tpo_head', 'tpo_coordinator');

router.post('/cohorts/:cohortId/notices', institutionAuth, WRITE, async (req, res) => {
  try { const n = await getService(router._deps).createNotice({ ...institutionScope(req), createdBy: req.institution.institutionUserId }, req.params.cohortId, req.body || {});
    return res.status(201).json({ success: true, data: n });
  } catch (err) { if (err.name === 'ValidationError' || err.name === 'CastError') return res.status(400).json({ success: false, code: 'VALIDATION', message: 'Invalid notice data.' });
    console.error('[institution/notices:create]', err.message); return res.status(500).json({ success: false, message: 'Could not create notice.' }); }
});
router.get('/cohorts/:cohortId/notices', institutionAuth, async (req, res) => {
  try { const data = await getService(router._deps).listNotices(institutionScope(req), req.params.cohortId);
    return res.status(200).json({ success: true, data });
  } catch (err) { console.error('[institution/notices:list]', err.message); return res.status(500).json({ success: false, message: 'Could not list notices.' }); }
});
router.patch('/cohorts/:cohortId/notices/:noticeId', institutionAuth, WRITE, async (req, res) => {
  try { const n = await getService(router._deps).updateNotice(institutionScope(req), req.params.cohortId, req.params.noticeId, req.body || {});
    return res.status(200).json({ success: true, data: n });
  } catch (err) { if (err.message === 'NOTICE_NOT_FOUND') return res.status(404).json({ success: false, message: 'Notice not found.' });
    if (err.name === 'ValidationError' || err.name === 'CastError') return res.status(400).json({ success: false, code: 'VALIDATION', message: 'Invalid notice data.' });
    console.error('[institution/notices:update]', err.message); return res.status(500).json({ success: false, message: 'Could not update notice.' }); }
});
router.delete('/cohorts/:cohortId/notices/:noticeId', institutionAuth, WRITE, async (req, res) => {
  try { await getService(router._deps).deleteNotice(institutionScope(req), req.params.cohortId, req.params.noticeId);
    return res.status(200).json({ success: true });
  } catch (err) { if (err.message === 'NOTICE_NOT_FOUND') return res.status(404).json({ success: false, message: 'Notice not found.' });
    console.error('[institution/notices:delete]', err.message); return res.status(500).json({ success: false, message: 'Could not delete notice.' }); }
});
module.exports = router;
