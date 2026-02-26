const router = require('express').Router();
const ctrl = require('../controllers/userController');
const auth = require('../middleware/auth');

router.use(auth);

router.get('/me', ctrl.getProfile);
router.put('/me', ctrl.updateProfile);
router.delete('/me', ctrl.deleteAccount);
router.get('/:userId', ctrl.getPublicProfile);

module.exports = router;
