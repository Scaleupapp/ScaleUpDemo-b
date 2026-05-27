'use strict';

const router = require('express').Router();
const {
  getToday,
  startDrill,
  submitDrill,
  getResult,
  startCalibration,
  submitCalibration,
  getCalibrationResult,
  requestDrill,
} = require('../controllers/drills.controller');
const auth = require('../../middleware/auth');

/**
 * GET /api/coding/drills/today
 * Returns the recommended drill for the authenticated user.
 */
router.get('/today', auth, getToday);

// ---------------------------------------------------------------------------
// Calibration routes — must be declared BEFORE /:id/... routes to avoid
// Express matching "calibration" as the :id parameter.
// ---------------------------------------------------------------------------

/**
 * POST /api/coding/drills/calibration/start
 * Returns 4 easy-difficulty drill bundles (one per subtype) as a calibration sequence.
 */
router.post('/calibration/start', auth, startCalibration);

/**
 * POST /api/coding/drills/calibration/:calibration_id/submit
 * Accepts all 4 calibration submissions in one payload; enqueues 4 grader jobs.
 */
router.post('/calibration/:calibration_id/submit', auth, submitCalibration);

/**
 * GET /api/coding/drills/calibration/:calibration_id/result
 * Returns aggregate calibration result; writes Mastery + DifficultyState when all 4 graded.
 */
router.get('/calibration/:calibration_id/result', auth, getCalibrationResult);

/**
 * POST /api/coding/drills/request
 * On-demand drill request — bypasses daily quota. Body: { drill_subtype?, difficulty?, topic_hint? }.
 * Must be declared BEFORE /:id/... routes to avoid Express matching "request" as :id.
 */
router.post('/request', auth, requestDrill);

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
