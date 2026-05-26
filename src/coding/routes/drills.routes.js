'use strict';

const router = require('express').Router();
const { getToday } = require('../controllers/drills.controller');
const auth = require('../../middleware/auth');

/**
 * GET /api/coding/drills/today
 * Returns the recommended drill for the authenticated user.
 */
router.get('/today', auth, getToday);

module.exports = router;
