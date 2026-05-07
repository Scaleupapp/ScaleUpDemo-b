const router    = require('express').Router();
const adminAuth = require('../middleware/adminAuth');
const ctrl      = require('../controllers/diagnosticAdminController');

// All routes require admin authentication
router.use(adminAuth);

// Queue and stats
router.get('/queue',  ctrl.getQueue);
router.get('/stats',  ctrl.getStats);

// Per-question actions
router.post('/:id/approve', ctrl.approve);
router.post('/:id/edit',    ctrl.edit);
router.post('/:id/reject',  ctrl.reject);

module.exports = router;
