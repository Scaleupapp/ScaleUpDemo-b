const router = require('express').Router();
const ctrl = require('../controllers/contentController');
const auth = require('../middleware/auth');
const rbac = require('../middleware/rbac');

// Creator endpoints
router.post('/request-upload', auth, rbac('creator'), ctrl.requestUpload);
router.post('/complete-upload', auth, rbac('creator'), ctrl.completeUpload);
router.get('/my-content', auth, rbac('creator'), ctrl.getMyContent);
router.put('/:id', auth, rbac('creator'), ctrl.updateContent);
router.post('/:id/publish', auth, rbac('creator'), ctrl.publishContent);
router.post('/:id/unpublish', auth, rbac('creator'), ctrl.unpublishContent);
router.delete('/:id', auth, rbac('creator'), ctrl.deleteContent);

// Consumer endpoints
router.get('/feed', auth, ctrl.getFeed);
router.get('/explore', auth, ctrl.explore);
router.get('/liked', auth, ctrl.getLikedContent);
router.get('/saved', auth, ctrl.getSavedContent);
router.get('/:id', auth, ctrl.getContent);
router.get('/:id/stream', auth, ctrl.getStreamUrl);
router.post('/:id/like', auth, ctrl.toggleLike);
router.post('/:id/save', auth, ctrl.toggleSave);
router.post('/:id/rate', auth, ctrl.rateContent);
router.post('/:id/share', auth, ctrl.trackShare);
router.post('/:id/report', auth, ctrl.reportContent);
router.get('/:id/comments', auth, ctrl.getComments);
router.post('/:id/comments', auth, ctrl.addComment);

module.exports = router;

