const router = require('express').Router();
const ctrl = require('../controllers/quizController');
const auth = require('../middleware/auth');

router.use(auth);

router.get('/', ctrl.listQuizzes);
router.get('/history', ctrl.getHistory);
router.post('/request', ctrl.requestOnDemand);
router.get('/trigger/:triggerId', ctrl.getTriggerStatus);
router.get('/:id', ctrl.getQuiz);
router.post('/:id/start', ctrl.startAttempt);
router.put('/:id/answer', ctrl.submitAnswer);
router.post('/:id/complete', ctrl.completeQuiz);
router.get('/:id/results', ctrl.getResults);

module.exports = router;
