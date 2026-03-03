const router = require('express').Router();
const multer = require('multer');
const ctrl = require('../controllers/userController');
const auth = require('../middleware/auth');

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
router.put('/me', ctrl.updateProfile);
router.put('/me/avatar', upload.single('avatar'), ctrl.uploadAvatar);
router.delete('/me', ctrl.deleteAccount);
router.get('/:userId', ctrl.getPublicProfile);

module.exports = router;
