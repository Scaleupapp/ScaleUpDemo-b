const Notification = require('../models/Notification');
const apiResponse = require('../utils/apiResponse');

const getNotifications = async (req, res, next) => {
  try {
    const { page = 1, limit = 30 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find({ userId: req.user.userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Notification.countDocuments({ userId: req.user.userId }),
      Notification.countDocuments({ userId: req.user.userId, isRead: false }),
    ]);

    res.json(apiResponse.success({
      notifications,
      unreadCount,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit)),
      },
    }));
  } catch (err) {
    next(err);
  }
};

const getUnreadCount = async (req, res, next) => {
  try {
    const count = await Notification.countDocuments({ userId: req.user.userId, isRead: false });
    res.json(apiResponse.success({ unreadCount: count }));
  } catch (err) {
    next(err);
  }
};

const markAsRead = async (req, res, next) => {
  try {
    await Notification.updateOne(
      { _id: req.params.id, userId: req.user.userId },
      { $set: { isRead: true } }
    );
    res.json(apiResponse.success(null, 'Notification marked as read'));
  } catch (err) {
    next(err);
  }
};

const markAllAsRead = async (req, res, next) => {
  try {
    await Notification.updateMany(
      { userId: req.user.userId, isRead: false },
      { $set: { isRead: true } }
    );
    res.json(apiResponse.success(null, 'All notifications marked as read'));
  } catch (err) {
    next(err);
  }
};

const dismiss = async (req, res, next) => {
  try {
    await Notification.deleteOne({ _id: req.params.id, userId: req.user.userId });
    res.json(apiResponse.success(null, 'Notification dismissed'));
  } catch (err) {
    next(err);
  }
};

const sendTestNotification = async (req, res, next) => {
  try {
    const notificationService = require('../services/notificationService');
    await notificationService.sendToUser(req.user.userId, {
      title: 'Welcome to ScaleUp!',
      body: 'Your notifications are working. Keep learning and growing!',
      data: { deepLink: '/home' },
    });
    res.json(apiResponse.success(null, 'Test notification sent'));
  } catch (err) {
    next(err);
  }
};

module.exports = { getNotifications, getUnreadCount, markAsRead, markAllAsRead, dismiss, sendTestNotification };
