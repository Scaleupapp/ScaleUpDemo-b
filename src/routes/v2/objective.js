/**
 * v2 Objective routes.
 *
 * Only what v2 needs that v1 doesn't already provide:
 *   POST /api/v2/objective/required-time — compute hours/week required (not asked)
 *
 * v1 objective CRUD is still at /api/v1/objectives — unchanged.
 */
const express = require('express');
const auth = require('../../middleware/auth');
const { computeRequiredTime } = require('../../services/v2/requiredTimeService');

const router = express.Router();

/**
 * POST /api/v2/objective/required-time
 * Body: { objectiveType, specifics, timeline, currentLevel }
 * Returns: { requiredHoursPerWeek, paths: { commit, lessTime, moreTime }, warnings, ... }
 *
 * No DB write — pure computation. Client uses this during onboarding to surface
 * the honest reality-check screen before saving the objective.
 */
router.post('/required-time', auth, (req, res) => {
  const { objectiveType, specifics, timeline, currentLevel } = req.body || {};

  if (!objectiveType || !timeline) {
    return res.status(400).json({
      success: false,
      message: 'objectiveType and timeline are required',
    });
  }

  try {
    const result = computeRequiredTime({
      objectiveType,
      specifics: specifics || {},
      timeline,
      currentLevel: currentLevel || 'beginner',
    });
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('[v2/objective/required-time] error', err);
    return res.status(500).json({ success: false, message: 'Computation failed' });
  }
});

module.exports = router;
