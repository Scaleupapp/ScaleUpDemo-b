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
router.use('/you', require('./you'));
router.use('/taxonomy', require('./taxonomy'));
router.use('/opt-in', require('./optIn'));

router.get('/health', (_req, res) => res.json({ status: 'ok', namespace: 'v2', ts: new Date() }));

module.exports = router;
