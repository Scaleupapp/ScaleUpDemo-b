const router = require('express').Router();
const ctrl = require('../controllers/audioSummaryController');
const auth = require('../middleware/auth');

router.use(auth);

router.post('/generate', ctrl.generateAudioSummary);
router.get('/:contentId', ctrl.getAudioSummary);
router.get('/:contentId/status', ctrl.getAudioStatus);

module.exports = router;
