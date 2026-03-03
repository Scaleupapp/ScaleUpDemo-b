const router = require('express').Router();
const ctrl = require('../controllers/recommendationController');
const auth = require('../middleware/auth');

router.use(auth);

router.get('/feed', ctrl.getPersonalizedFeed);
router.get('/similar/:id', ctrl.getSimilarContent);
router.get('/objective/:objectiveId', ctrl.getObjectiveRecommendations);
router.get('/gaps', ctrl.getGapFilling);
router.get('/trending', ctrl.getTrending);
router.get('/next-actions', ctrl.getNextActions);
router.get('/post-quiz', ctrl.getPostQuizRecommendations);

module.exports = router;
