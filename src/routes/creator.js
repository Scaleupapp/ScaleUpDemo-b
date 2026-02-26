const router = require('express').Router();
const ctrl = require('../controllers/creatorController');
const auth = require('../middleware/auth');
const rbac = require('../middleware/rbac');

router.use(auth);

// Any user can apply to become a creator
router.post('/apply', ctrl.apply);
router.get('/application', ctrl.getMyApplication);

// Any user can search for creators
router.get('/search', ctrl.searchCreators);

// Creator-only: profile management
router.get('/profile', rbac('creator'), ctrl.getMyProfile);
router.put('/profile', rbac('creator'), ctrl.updateProfile);

// Core/anchor creators: browse pending applications in their domain + endorse
router.get('/applications', rbac('creator'), ctrl.getPendingApplications);
router.post('/applications/:applicationId/endorse', rbac('creator'), ctrl.endorseApplication);

module.exports = router;
