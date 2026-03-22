const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: {
    type: String,
    enum: ['quiz_available', 'milestone_reached', 'streak_reminder', 'journey_update', 'social_follow', 'social_comment'],
    required: true,
  },
  objectiveId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'UserObjective',
    default: null
  }, // null = global notification, set = objective-specific
  title: { type: String, required: true },
  message: { type: String, required: true },
  isRead: { type: Boolean, default: false },
  deepLink: { type: String, default: null },
}, { timestamps: true });

notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, isRead: 1 });

module.exports = mongoose.model('Notification', notificationSchema);
