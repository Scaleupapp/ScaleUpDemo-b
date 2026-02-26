const router = require('express').Router();
const ctrl = require('../controllers/knowledgeController');
const auth = require('../middleware/auth');

router.use(auth);

router.get('/profile', ctrl.getProfile);
router.get('/topic/:topic', ctrl.getTopicDetail);
router.get('/gaps', ctrl.getGaps);
router.get('/strengths', ctrl.getStrengths);

module.exports = router;
