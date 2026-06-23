'use strict';
const express = require('express');
const institutionAuth = require('../../middleware/institutionAuth');
const { institutionScope, requireInstitutionRole } = require('../../middleware/institutionScope');

const router = express.Router();
router._deps = null;
function svc() { return (router._deps && router._deps.assessmentService) || require('../../services/institution/assessment/assessmentService'); }

// Configure (maker): tpo_head, tpo_coordinator
router.post('/assessments', institutionAuth, requireInstitutionRole('tpo_head', 'tpo_coordinator'), async (req, res) => {
  try {
    const { cohortId, type, title } = req.body || {};
    if (!cohortId || !type || !title) return res.status(400).json({ success: false, code: 'VALIDATION', message: 'cohortId, type and title are required.' });
    const a = await svc().createAssessment(institutionScope(req), { ...req.body, createdBy: req.institution.institutionUserId });
    return res.status(201).json({ success: true, data: a });
  } catch (err) {
    if (err.name === 'ValidationError') return res.status(400).json({ success: false, code: 'VALIDATION', message: 'Invalid assessment data.' });
    console.error('[institution/assessments:create]', err.message);
    return res.status(500).json({ success: false, message: 'Could not create the assessment.' });
  }
});

// Release (checker): tpo_head, institution_admin  — different roles than configure
router.post('/assessments/:id/release', institutionAuth, requireInstitutionRole('tpo_head', 'institution_admin'), async (req, res) => {
  try {
    const a = await svc().releaseAssessment(institutionScope(req), req.params.id, req.institution.institutionUserId);
    return res.status(200).json({ success: true, data: { id: String(a._id), status: a.status, releasedAt: a.releasedAt } });
  } catch (err) {
    if (err.message === 'NOT_FOUND') return res.status(404).json({ success: false, message: 'Assessment not found' });
    if (err.message === 'BAD_STATUS') return res.status(409).json({ success: false, code: 'BAD_STATUS', message: 'Only a configured assessment can be released.' });
    console.error('[institution/assessments:release]', err.message);
    return res.status(500).json({ success: false, message: 'Could not release the assessment.' });
  }
});

// List + get (any institution role)
router.get('/assessments', institutionAuth, async (req, res) => {
  try { return res.status(200).json({ success: true, data: await svc().listAssessments(institutionScope(req), { cohortId: req.query.cohortId }) }); }
  catch (err) { console.error('[institution/assessments:list]', err.message); return res.status(500).json({ success: false, message: 'Could not list assessments.' }); }
});
router.get('/assessments/:id', institutionAuth, async (req, res) => {
  try {
    const a = await svc().getAssessment(institutionScope(req), req.params.id);
    if (!a) return res.status(404).json({ success: false, message: 'Assessment not found' });
    return res.status(200).json({ success: true, data: a });
  } catch (err) { console.error('[institution/assessments:get]', err.message); return res.status(500).json({ success: false, message: 'Could not load the assessment.' }); }
});

module.exports = router;
