const router = require('express').Router();
const ctrl = require('../controllers/progressController');
const auth = require('../middleware/auth');

router.use(auth);

router.put('/:contentId', ctrl.updateProgress);
router.post('/:contentId/complete', ctrl.markCompleted);
router.get('/history', ctrl.getHistory);
router.get('/stats', ctrl.getStats);

module.exports = router;
