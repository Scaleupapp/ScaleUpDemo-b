const router = require('express').Router();
const ctrl = require('../controllers/notesController');
const analyticsCtrl = require('../controllers/notesAnalyticsController');
const auth = require('../middleware/auth');

// Any authenticated user can upload notes (no creator gate)
router.post('/request-upload', auth, ctrl.requestUpload);
router.post('/complete-upload', auth, ctrl.completeUpload);
router.post('/request-thumbnail-upload', auth, ctrl.requestThumbnailUpload);
router.post('/multipart/initiate', auth, ctrl.initiateMultipart);
router.post('/multipart/complete', auth, ctrl.completeMultipart);
router.post('/multipart/abort', auth, ctrl.abortMultipart);

// Notes management
router.get('/my-notes', auth, ctrl.getMyNotes);
router.get('/analytics', auth, analyticsCtrl.getAnalytics);
router.get('/analytics/:id', auth, analyticsCtrl.getNoteDetail);
router.put('/:id', auth, ctrl.updateNote);
router.post('/:id/publish', auth, ctrl.publishNote);
router.post('/:id/unpublish', auth, ctrl.unpublishNote);
router.delete('/:id', auth, ctrl.deleteNote);

module.exports = router;
