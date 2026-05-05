const router = require('express').Router();
const ctrl = require('../controllers/diagnosticController');
const syllabusController = require('../controllers/diagnosticSyllabusController');
const auth = require('../middleware/auth');

router.use(auth);
router.use(ctrl._gateOrPass);

router.get('/synthesis', ctrl.synthesis);
router.post('/start', ctrl.start);
router.post('/:attemptId/self-rating', ctrl.submitSelfRating);
router.get('/:attemptId/next-question', ctrl.nextQuestion);
router.post('/:attemptId/answer', ctrl.submitAnswer);
router.post('/:attemptId/finish', ctrl.finish);
router.post('/:attemptId/abandon', ctrl.abandon);

// Syllabus upload (Phase 2a Task 9)
router.post('/syllabus/upload-init', syllabusController.initSyllabusUpload);
router.post('/syllabus/:id/complete', syllabusController.completeSyllabusUpload);
router.get('/syllabus/:id/status', syllabusController.getSyllabusStatus);

module.exports = router;
