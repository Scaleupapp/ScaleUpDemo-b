const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: {
    type: String,
    enum: ['quiz_available', 'milestone_reached', 'streak_reminder', 'journey_update', 'social_follow', 'social_comment', 'competition_challenge', 'competition_results', 'competition_reminder', 'creator_application', 'verified_contributor', 'note_request_fulfilled', 'note_request_claimed', 'coding_drill_ready', 'coding_calibration_invitation', 'coding_difficulty_change_suggestion'],
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
