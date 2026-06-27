'use strict';
const express = require('express');
const institutionAuth = require('../../middleware/institutionAuth');
const { institutionScope } = require('../../middleware/institutionScope');
const router = express.Router();

router.get('/ping', institutionAuth, (req, res) => {
  const scope = institutionScope(req);
  res.json({ success: true, data: { ok: true, institutionId: scope.institutionId, role: req.institution.role } });
});

router.use('/auth', require('./auth'));
router.use('/me', require('./me'));
router.use('/', require('./org'));
router.use('/', require('./users'));
router.use('/', require('./rosters'));
router.use('/', require('./objectiveTemplates'));
router.use('/', require('./assessments'));
router.use('/', require('./assessmentSources'));
router.use('/', require('./uploads'));
router.use('/', require('./notices'));
router.use('/', require('./shelves'));
router.use('/', require('./outcomes'));
router.use('/', require('./driveApplications'));
router.use('/', require('./dashboard'));

module.exports = router;
