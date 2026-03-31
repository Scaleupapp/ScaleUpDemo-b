const router = require('express').Router();
const ctrl = require('../controllers/flashcardController');
const auth = require('../middleware/auth');

router.use(auth);

router.post('/generate', ctrl.generateFlashcards);
router.get('/', ctrl.listFlashcards);
router.get('/:id', ctrl.getFlashcardSet);
router.post('/:id/study', ctrl.recordStudy);
router.delete('/:id', ctrl.deleteFlashcardSet);

module.exports = router;
