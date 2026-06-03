/**
 * v2 API namespace
 *
 * Co-exists with /api/v1/* — v1 routes remain untouched and operational.
 * v2 surfaces only the new capabilities required for the v2 UX redesign:
 *   - required-time computation
 *   - readiness trajectory forecast
 *   - predicted-impact-per-task estimator
 *   - top-3 leverage actions
 *   - Compass orchestrator (unified AI surface)
 *
 * Rollback strategy: drop the v2 mount in app.js. v1 keeps working.
 */
const express = require('express');
const router = express.Router();

router.use('/objective', require('./objective'));
router.use('/diagnostic', require('./diagnostic'));
router.use('/plan', require('./plan'));
router.use('/compass', require('./compass'));
router.use('/insights', require('./insights'));
router.use('/you/talent', require('./talent'));
router.use('/you', require('./you'));
router.use('/opt-in', require('./optIn'));
router.use('/me', require('./me'));

router.get('/health', (_req, res) => res.json({ status: 'ok', namespace: 'v2', ts: new Date() }));

// Config probe — clients call this at launch to decide v1 vs v2 routing.
// When the V2_API_ENABLED kill switch is off, app.js answers this directly
// (this handler is only reached when v2 IS enabled).
router.get('/config', (_req, res) => res.json({
  success: true,
  data: {
    v2ApiEnabled: true,
    // v2ForNewUsers: flip to true (via env) only after the v2 onboarding
    // rebuild is shipped + tested. Until then fresh users stay on v1.
    v2ForNewUsers: process.env.V2_FOR_NEW_USERS === 'true',
  },
}));

module.exports = router;
