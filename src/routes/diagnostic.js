const router = require('express').Router();
const ctrl = require('../controllers/diagnosticController');
const auth = require('../middleware/auth');

router.use(ctrl._gateOrPass);
router.use(auth);

router.get('/synthesis', ctrl.synthesis);
router.post('/start', ctrl.start);
router.post('/:attemptId/self-rating', ctrl.submitSelfRating);
router.get('/:attemptId/next-question', ctrl.nextQuestion);
router.post('/:attemptId/answer', ctrl.submitAnswer);
router.post('/:attemptId/finish', ctrl.finish);
router.post('/:attemptId/abandon', ctrl.abandon);

module.exports = router;
