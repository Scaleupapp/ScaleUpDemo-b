const router = require('express').Router();
const ctrl = require('../controllers/youtubeController');
const auth = require('../middleware/auth');
const rbac = require('../middleware/rbac');

router.use(auth);
router.use(rbac('admin'));

router.post('/import/video', ctrl.importVideo);
router.post('/import/channel', ctrl.importChannel);
router.post('/import/playlist', ctrl.importPlaylist);
router.get('/search', ctrl.searchVideos);
router.get('/imports', ctrl.listImports);

module.exports = router;
