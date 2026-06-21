'use strict';
const express = require('express');
const institutionAuth = require('../../middleware/institutionAuth');
const { institutionScope, requireInstitutionRole } = require('../../middleware/institutionScope');

const router = express.Router();

// ── Dependency injection seam ────────────────────────────────────────────────
// Production: null → real orgService is required inline.
// Tests: set `org._deps = { orgService }` before the request.
router._deps = null;

function getService(deps) {
  if (deps && deps.orgService) return deps.orgService;
  return require('../../services/institution/orgService');
}

// ── POST /departments ────────────────────────────────────────────────────────
// Gate: institution_admin, tpo_head
router.post(
  '/departments',
  institutionAuth,
  requireInstitutionRole('institution_admin', 'tpo_head'),
  async (req, res) => {
    try {
      const orgService = getService(router._deps);
      const scope = institutionScope(req);
      const { name, code, capabilityTracks } = req.body || {};
      if (!name || !String(name).trim()) {
        return res.status(400).json({ success: false, code: 'VALIDATION', message: 'Department name is required.' });
      }
      const dept = await orgService.createDepartment(scope, { name, code, capabilityTracks });
      return res.status(201).json({ success: true, data: dept });
    } catch (err) {
      if (err.name === 'ValidationError') {
        return res.status(400).json({ success: false, code: 'VALIDATION', message: 'Invalid department data.' });
      }
      console.error('[institution/departments:create]', err.message);
      return res.status(500).json({ success: false, message: 'Could not create department.' });
    }
  }
);

// ── GET /departments ─────────────────────────────────────────────────────────
// Gate: any authenticated institution role
router.get(
  '/departments',
  institutionAuth,
  async (req, res) => {
    try {
      const orgService = getService(router._deps);
      const scope = institutionScope(req);
      const departments = await orgService.listDepartments(scope);
      return res.status(200).json({ success: true, data: departments });
    } catch (err) {
      console.error('[institution/departments:list]', err.message);
      return res.status(500).json({ success: false, message: 'Could not list departments.' });
    }
  }
);

// ── POST /cohorts ────────────────────────────────────────────────────────────
// Gate: institution_admin, tpo_head
router.post(
  '/cohorts',
  institutionAuth,
  requireInstitutionRole('institution_admin', 'tpo_head'),
  async (req, res) => {
    try {
      const orgService = getService(router._deps);
      const scope = institutionScope(req);
      const { departmentId, year, label, placementSeason } = req.body || {};
      if (!departmentId) {
        return res.status(400).json({ success: false, code: 'VALIDATION', message: 'departmentId is required.' });
      }
      const cohort = await orgService.createCohort(scope, { departmentId, year, label, placementSeason });
      return res.status(201).json({ success: true, data: cohort });
    } catch (err) {
      if (err.message === 'DEPARTMENT_NOT_FOUND') {
        return res.status(404).json({ success: false, message: 'Department not found in this institution' });
      }
      if (err.name === 'ValidationError' || err.name === 'CastError') {
        return res.status(400).json({ success: false, code: 'VALIDATION', message: 'Invalid cohort data.' });
      }
      console.error('[institution/cohorts:create]', err.message);
      return res.status(500).json({ success: false, message: 'Could not create cohort.' });
    }
  }
);

// ── GET /cohorts ─────────────────────────────────────────────────────────────
// Gate: any authenticated institution role
// Optional query param: ?departmentId=...
router.get(
  '/cohorts',
  institutionAuth,
  async (req, res) => {
    try {
      const orgService = getService(router._deps);
      const scope = institutionScope(req);
      const { departmentId } = req.query;
      const cohorts = await orgService.listCohorts(scope, { departmentId });
      return res.status(200).json({ success: true, data: cohorts });
    } catch (err) {
      console.error('[institution/cohorts:list]', err.message);
      return res.status(500).json({ success: false, message: 'Could not list cohorts.' });
    }
  }
);

module.exports = router;
