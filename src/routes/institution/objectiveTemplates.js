'use strict';
const express = require('express');
const institutionAuth = require('../../middleware/institutionAuth');
const { institutionScope, requireInstitutionRole } = require('../../middleware/institutionScope');

const router = express.Router();

// ── DI seam ──────────────────────────────────────────────────────────────────
// Production: null → real services/models required inline.
// Tests: set objectiveTemplates._deps = { objectiveTemplateService, InstitutionCohort } before the request.
router._deps = null;
function svc() {
  if (router._deps && router._deps.objectiveTemplateService) return router._deps.objectiveTemplateService;
  return require('../../services/institution/objectiveTemplateService');
}
function cohortModel() {
  if (router._deps && router._deps.InstitutionCohort) return router._deps.InstitutionCohort;
  return require('../../models/InstitutionCohort');
}

// ── POST /objective-templates ── Gate: institution_admin, tpo_head
router.post('/objective-templates', institutionAuth, requireInstitutionRole('institution_admin', 'tpo_head'), async (req, res) => {
  try {
    const { label, objectiveType, specifics, competencies, capabilityTrack } = req.body || {};
    if (!label || !String(label).trim()) return res.status(400).json({ success: false, code: 'VALIDATION', message: 'A template label is required.' });
    if (!objectiveType) return res.status(400).json({ success: false, code: 'VALIDATION', message: 'objectiveType is required.' });
    const tpl = await svc().createTemplate(
      institutionScope(req),
      { label, objectiveType, specifics, competencies, capabilityTrack, createdBy: req.institution.institutionUserId },
    );
    return res.status(201).json({ success: true, data: tpl });
  } catch (err) {
    if (err.name === 'ValidationError') return res.status(400).json({ success: false, code: 'VALIDATION', message: 'Invalid template data.' });
    console.error('[institution/objective-templates:create]', err.message);
    return res.status(500).json({ success: false, message: 'Could not create the template.' });
  }
});

// ── GET /objective-templates ── Gate: any authenticated institution role
router.get('/objective-templates', institutionAuth, async (req, res) => {
  try {
    const list = await svc().listTemplates(institutionScope(req));
    return res.status(200).json({ success: true, data: list });
  } catch (err) {
    console.error('[institution/objective-templates:list]', err.message);
    return res.status(500).json({ success: false, message: 'Could not list templates.' });
  }
});

// ── GET /objective-templates/:id ── Gate: any authenticated institution role
router.get('/objective-templates/:id', institutionAuth, async (req, res) => {
  try {
    const tpl = await svc().getTemplate(institutionScope(req), req.params.id);
    if (!tpl) return res.status(404).json({ success: false, message: 'Template not found' });
    return res.status(200).json({ success: true, data: tpl });
  } catch (err) {
    console.error('[institution/objective-templates:get]', err.message);
    return res.status(500).json({ success: false, message: 'Could not load the template.' });
  }
});

// ── PUT /cohorts/:cohortId/objective-template ── Gate: institution_admin, tpo_head
// Attaches a template (validated to belong to this institution) to a cohort.
router.put('/cohorts/:cohortId/objective-template', institutionAuth, requireInstitutionRole('institution_admin', 'tpo_head'), async (req, res) => {
  try {
    const { objectiveTemplateId } = req.body || {};
    if (!objectiveTemplateId) return res.status(400).json({ success: false, code: 'VALIDATION', message: 'objectiveTemplateId is required.' });
    const tpl = await svc().getTemplate(institutionScope(req), objectiveTemplateId);
    if (!tpl) return res.status(404).json({ success: false, code: 'TEMPLATE_NOT_FOUND', message: 'Template not found in this institution' });
    const InstitutionCohort = cohortModel();
    const cohort = await InstitutionCohort.findOne(institutionScope(req, { _id: req.params.cohortId }));
    if (!cohort) return res.status(404).json({ success: false, message: 'Cohort not found' });
    cohort.objectiveTemplateId = objectiveTemplateId;
    await cohort.save();
    return res.status(200).json({ success: true, data: { cohortId: String(cohort._id), objectiveTemplateId: String(objectiveTemplateId) } });
  } catch (err) {
    console.error('[institution/cohorts:attach-template]', err.message);
    return res.status(500).json({ success: false, message: 'Could not attach the template.' });
  }
});

module.exports = router;
