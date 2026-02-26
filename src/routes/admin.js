const router = require('express').Router();
const ctrl = require('../controllers/adminController');
const auth = require('../middleware/auth');
const rbac = require('../middleware/rbac');

router.use(auth, rbac('admin'));

// Creator applications (admin can view all + reject spam)
router.get('/applications', ctrl.getPendingApplications);
router.post('/applications/:id/reject', ctrl.rejectApplication);

// User management
router.get('/users', ctrl.getUsers);
router.put('/users/:id/ban', ctrl.banUser);
router.put('/users/:id/unban', ctrl.unbanUser);

// Content moderation
router.put('/content/:id/moderate', ctrl.moderateContent);

// Platform stats
router.get('/stats', ctrl.getStats);

module.exports = router;
