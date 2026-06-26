'use strict';
const express = require('express');
const institutionAuth = require('../../middleware/institutionAuth');
const { institutionScope, requireInstitutionRole } = require('../../middleware/institutionScope');
const router = express.Router();
router._deps = null;
function getGen(deps) { return (deps && deps.generateUploadURL) || require('../../config/s3').generateUploadURL; }
function safeName(n) { return String(n || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120); }

router.post('/uploads/sign', institutionAuth, requireInstitutionRole('institution_admin', 'tpo_head', 'tpo_coordinator'), async (req, res) => {
  try {
    const scope = institutionScope(req);
    const { fileName, contentType } = req.body || {};
    if (!fileName) return res.status(400).json({ success: false, code: 'VALIDATION', message: 'fileName is required.' });
    const key = `institution/${scope.institutionId}/uploads/${Date.now()}-${safeName(fileName)}`;
    const uploadUrl = await getGen(router._deps)(key, contentType || 'application/octet-stream');
    return res.status(200).json({ success: true, data: { uploadUrl, s3Key: key } });
  } catch (err) {
    console.error('[institution/uploads:sign]', err.message);
    return res.status(500).json({ success: false, message: 'Could not create upload URL.' });
  }
});
module.exports = router;
