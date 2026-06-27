'use strict';
const express = require('express');
const institutionAuth = require('../../middleware/institutionAuth');
const { institutionScope } = require('../../middleware/institutionScope');
const router = express.Router();
router._deps = null;
function getService(deps) { return (deps && deps.dashboardService) || require('../../services/institution/dashboardService'); }
router.get('/dashboard', institutionAuth, async (req, res) => {
  try { const data = await getService(router._deps).build(institutionScope(req));
    return res.status(200).json({ success: true, data });
  } catch (err) { console.error('[institution/dashboard]', err.message); return res.status(500).json({ success: false, message: 'Could not load dashboard.' }); }
});
module.exports = router;
