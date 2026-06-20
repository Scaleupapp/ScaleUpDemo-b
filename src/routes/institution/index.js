'use strict';
const express = require('express');
const institutionAuth = require('../../middleware/institutionAuth');
const { institutionScope } = require('../../middleware/institutionScope');
const router = express.Router();

router.get('/ping', institutionAuth, (req, res) => {
  const scope = institutionScope(req);
  res.json({ success: true, data: { ok: true, institutionId: scope.institutionId, role: req.institution.role } });
});

router.use('/', require('./rosters'));

module.exports = router;
