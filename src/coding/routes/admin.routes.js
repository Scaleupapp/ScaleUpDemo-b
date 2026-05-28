'use strict';

const router = require('express').Router();
const adminAuth = require('../../middleware/adminAuth');
const dashboard = require('../controllers/adminDashboard.controller');

router.use(adminAuth);

router.get('/anchor-drift', dashboard.anchorDrift);
router.get('/human-review', dashboard.humanReview);
router.get('/cost-summary', dashboard.costSummary);
router.get('/recent-sessions', dashboard.recentSessions);

module.exports = router;
