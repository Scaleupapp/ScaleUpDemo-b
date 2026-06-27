'use strict';
const express = require('express');
const institutionAuth = require('../../middleware/institutionAuth');
const { institutionScope, requireInstitutionRole } = require('../../middleware/institutionScope');
const router = express.Router();
router._deps = null;

function getService(deps) {
  return (deps && deps.driveApplicationService) || require('../../services/institution/driveApplicationService');
}

const WRITE = requireInstitutionRole('institution_admin', 'tpo_head', 'tpo_coordinator');

// GET — any institution role
router.get('/cohorts/:cohortId/drives/:driveId/applications', institutionAuth, async (req, res) => {
  try {
    const data = await getService(router._deps).listByDrive(
      institutionScope(req),
      req.params.cohortId,
      req.params.driveId,
      router._deps
    );
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error('[institution/driveApplications:list]', err.message);
    return res.status(500).json({ success: false, message: 'Could not list applications.' });
  }
});

// POST — role-gated
router.post('/cohorts/:cohortId/drives/:driveId/applications', institutionAuth, WRITE, async (req, res) => {
  try {
    const app = await getService(router._deps).addApplication(
      institutionScope(req),
      req.params.cohortId,
      req.params.driveId,
      req.body || {},
      router._deps
    );
    return res.status(201).json({ success: true, data: app });
  } catch (err) {
    if (err.name === 'ValidationError' || err.name === 'CastError') {
      return res.status(400).json({ success: false, code: 'VALIDATION', message: 'Invalid application data.' });
    }
    console.error('[institution/driveApplications:add]', err.message);
    return res.status(500).json({ success: false, message: 'Could not add application.' });
  }
});

// PATCH — role-gated
router.patch('/cohorts/:cohortId/drives/:driveId/applications/:id', institutionAuth, WRITE, async (req, res) => {
  try {
    const app = await getService(router._deps).moveStage(
      institutionScope(req),
      req.params.cohortId,
      req.params.driveId,
      req.params.id,
      req.body || {},
      router._deps
    );
    return res.status(200).json({ success: true, data: app });
  } catch (err) {
    if (err.message === 'APPLICATION_NOT_FOUND') {
      return res.status(404).json({ success: false, message: 'Application not found.' });
    }
    if (err.name === 'ValidationError' || err.name === 'CastError') {
      return res.status(400).json({ success: false, code: 'VALIDATION', message: 'Invalid application data.' });
    }
    console.error('[institution/driveApplications:patch]', err.message);
    return res.status(500).json({ success: false, message: 'Could not update application.' });
  }
});

// DELETE — role-gated
router.delete('/cohorts/:cohortId/drives/:driveId/applications/:id', institutionAuth, WRITE, async (req, res) => {
  try {
    await getService(router._deps).removeApplication(
      institutionScope(req),
      req.params.cohortId,
      req.params.driveId,
      req.params.id,
      router._deps
    );
    return res.status(200).json({ success: true });
  } catch (err) {
    if (err.message === 'APPLICATION_NOT_FOUND') {
      return res.status(404).json({ success: false, message: 'Application not found.' });
    }
    console.error('[institution/driveApplications:delete]', err.message);
    return res.status(500).json({ success: false, message: 'Could not delete application.' });
  }
});

module.exports = router;
