const router = require('express').Router();
const ctrl = require('../controllers/onboardingController');
const auth = require('../middleware/auth');

router.use(auth);
router.get('/', ctrl.getOnboardingStatus);
router.put('/profile', ctrl.updateProfile);
router.put('/background', ctrl.updateBackground);
router.post('/objective', ctrl.setObjective);
router.put('/preferences', ctrl.updatePreferences);
router.put('/interests', ctrl.updateInterests);
router.post('/complete', ctrl.completeOnboarding);

module.exports = router;
