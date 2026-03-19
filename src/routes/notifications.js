const router = require('express').Router();
const ctrl = require('../controllers/notificationController');
const auth = require('../middleware/auth');

router.use(auth);
router.get('/', ctrl.getNotifications);
router.get('/unread-count', ctrl.getUnreadCount);
router.put('/:id/read', ctrl.markAsRead);
router.post('/read-all', ctrl.markAllAsRead);
router.delete('/:id', ctrl.dismiss);
router.post('/test', ctrl.sendTestNotification);

module.exports = router;
