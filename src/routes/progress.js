const router = require('express').Router();
const ctrl = require('../controllers/progressController');
const auth = require('../middleware/auth');

router.use(auth);

// Static GET routes (before parameterized routes)
router.get('/history', ctrl.getHistory);
router.get('/stats', ctrl.getStats);
router.get('/activity-heatmap', ctrl.getActivityHeatmap);
router.get('/timeline', ctrl.getTimeline);
router.get('/insights', ctrl.getInsights);

// Parameterized routes
router.put('/:contentId', ctrl.updateProgress);
router.post('/:contentId/complete', ctrl.markCompleted);

module.exports = router;
