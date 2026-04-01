const router = require('express').Router();
const multer = require('multer');
const ctrl = require('../controllers/userController');
const auth = require('../middleware/auth');
const auditLog = require('../middleware/auditLog');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/heic', 'image/heif'].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, HEIC images allowed'), false);
    }
  },
});

router.use(auth);

router.get('/me', ctrl.getProfile);
router.put('/me', auditLog('profile_update', 'profile'), ctrl.updateProfile);
router.put('/me/avatar', auditLog('avatar_upload', 'profile'), upload.single('avatar'), ctrl.uploadAvatar);
router.delete('/me', auditLog('account_deactivate', 'data'), ctrl.deleteAccount);
router.get('/:userId', ctrl.getPublicProfile);
router.get('/:userId/contributor-card', ctrl.getContributorCard);

module.exports = router;
