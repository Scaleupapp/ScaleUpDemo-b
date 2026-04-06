const router = require('express').Router();
const multer = require('multer');
const ctrl = require('../controllers/interviewController');
const analyticsCtrl = require('../controllers/interviewAnalyticsController');
const auth = require('../middleware/auth');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png'].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG and PNG images allowed'), false);
    }
  },
});

router.use(auth);

router.post('/start', ctrl.startInterview);
router.get('/analytics', analyticsCtrl.getAnalytics);
router.post('/:id/complete', ctrl.completeInterview);
router.post('/:id/realtime-token', ctrl.getRealtimeToken);
router.post('/:id/upload-url', ctrl.getUploadURL);
router.post('/:id/process-answer', ctrl.processVoiceAnswer);
router.post('/:id/snapshot', upload.single('image'), ctrl.uploadSnapshot);
router.get('/:id/status', ctrl.getStatus);
router.get('/:id', ctrl.getSession);
router.get('/', ctrl.listSessions);
router.delete('/:id', ctrl.deleteSession);

module.exports = router;
