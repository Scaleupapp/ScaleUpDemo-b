const router = require('express').Router();
const multer = require('multer');
const ctrl = require('../controllers/diagnosticController');
const syllabusController = require('../controllers/diagnosticSyllabusController');
const auth = require('../middleware/auth');

const voiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

router.use(auth);
router.use(ctrl._gateOrPass);

router.get('/synthesis', ctrl.synthesis);
router.post('/start', ctrl.start);
router.post('/:attemptId/self-rating', ctrl.submitSelfRating);
router.get('/:attemptId/next-question', ctrl.nextQuestion);
router.post('/:attemptId/answer', ctrl.submitAnswer);
router.post('/:attemptId/finish', ctrl.finish);
router.post('/:attemptId/abandon', ctrl.abandon);

// Voice answer upload (Phase 3a Task 7)
router.post('/voice/upload', voiceUpload.single('audio'), ctrl.uploadVoiceAnswer);

// Syllabus upload (Phase 2a Task 9)
router.post('/syllabus/upload-init', syllabusController.initSyllabusUpload);
router.post('/syllabus/:id/complete', syllabusController.completeSyllabusUpload);
router.get('/syllabus/:id/status', syllabusController.getSyllabusStatus);

module.exports = router;
