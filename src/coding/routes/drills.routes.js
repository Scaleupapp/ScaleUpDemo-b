'use strict';

const router = require('express').Router();
const { getToday, startDrill, submitDrill, getResult } = require('../controllers/drills.controller');
const auth = require('../../middleware/auth');

/**
 * GET /api/coding/drills/today
 * Returns the recommended drill for the authenticated user.
 */
router.get('/today', auth, getToday);

/**
 * POST /api/coding/drills/:id/start
 * Creates a DrillAttempt, enforces daily quota, returns safe bundle view.
 */
router.post('/:id/start', auth, startDrill);

/**
 * POST /api/coding/drills/:id/submit
 * Validates and saves submission, enqueues grading job. Returns 202.
 */
router.post('/:id/submit', auth, submitDrill);

/**
 * GET /api/coding/drills/:id/result
 * Returns grade if graded, else 202 polling response.
 */
router.get('/:id/result', auth, getResult);

module.exports = router;
