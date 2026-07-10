const admin = require('../config/firebase');
const User = require('../models/User');
const Notification = require('../models/Notification');
const apnsPush = require('../config/apns');

class NotificationService {

  /**
   * Creates an in-app notification record (always) and sends a push notification (best-effort).
   */
  async sendToUser(userId, { title, body, data = {} }) {
    // Always persist an in-app notification
    try {
      await Notification.create({
        userId,
        type: this._mapDataTypeToNotificationType(data.type),
        title,
        message: body,
        deepLink: data.deepLink || null,
      });
    } catch (err) {
      console.error(`In-app notification creation failed for user ${userId}:`, err.message);
    }

    // Attempt push notification (best-effort)
    try {
      const user = await User.findById(userId).select('fcmToken').lean();
      if (!user || !user.fcmToken) return null;

      const token = user.fcmToken;

      // Detect if token is a raw APNs hex token (64-128 hex chars) vs FCM token
      if (this._isApnsToken(token)) {
        return await apnsPush.send(token, { title, body, data });
      }

      // FCM path
      if (!admin.apps.length) return null;

      const message = {
        token,
        notification: { title, body },
        data: this._stringifyData(data),
      };

      return await admin.messaging().send(message);
    } catch (err) {
      console.error(`Push notification failed for user ${userId}:`, err.message);
      return null;
    }
  }

  /**
   * Send a push notification to multiple users.
   */
  async sendToUsers(userIds, { title, body, data = {} }) {
    const users = await User.find({ _id: { $in: userIds }, fcmToken: { $exists: true, $ne: null } })
      .select('fcmToken').lean();

    if (users.length === 0) return [];

    const results = [];
    for (const user of users) {
      try {
        if (this._isApnsToken(user.fcmToken)) {
          await apnsPush.send(user.fcmToken, { title, body, data });
        } else if (admin.apps.length) {
          await admin.messaging().send({
            token: user.fcmToken,
            notification: { title, body },
            data: this._stringifyData(data),
          });
        }
        results.push({ success: true });
      } catch (err) {
        results.push({ success: false, error: err.message });
      }
    }

    return results;
  }

  /**
   * Send quiz-ready notification.
   */
  async notifyQuizReady(userId, quizId, triggerType) {
    const titleMap = {
      topic_threshold: 'Quiz Available',
      weekly_checkpoint: 'Weekly Review Quiz',
      retention_check: 'Knowledge Check',
      on_demand: 'Your Quiz is Ready',
    };

    return this.sendToUser(userId, {
      title: titleMap[triggerType] || 'New Quiz Available',
      body: 'A new quiz is ready for you. Test your knowledge!',
      data: { type: 'quiz_ready', quizId: quizId.toString() },
    });
  }

  /**
   * Send journey milestone notification.
   */
  async notifyMilestone(userId, milestoneName) {
    return this.sendToUser(userId, {
      title: 'Milestone Reached!',
      body: `You've reached: ${milestoneName}`,
      data: { type: 'milestone' },
    });
  }

  /**
   * Create an in-app notification without sending a push notification.
   */
  async createInApp(userId, { type, title, message, deepLink = null }) {
    try {
      return await Notification.create({ userId, type, title, message, deepLink });
    } catch (err) {
      console.error(`In-app notification creation failed for user ${userId}:`, err.message);
      return null;
    }
  }

  /**
   * Detect raw APNs device token (hex string, 64-200 chars, only hex chars).
   */
  _isApnsToken(token) {
    return /^[a-f0-9]{64,200}$/i.test(token);
  }

  /**
   * Ensure all data values are strings (FCM requirement).
   */
  _stringifyData(data) {
    const result = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = String(value);
    }
    return result;
  }

  /**
   * Maps push notification data.type to the in-app notification type enum.
   */
  _mapDataTypeToNotificationType(dataType) {
    const map = {
      quiz_ready: 'quiz_available',
      milestone: 'milestone_reached',
      streak: 'streak_reminder',
      streak_reminder: 'streak_reminder',
      journey_update: 'journey_update',
      re_engagement: 'journey_update',
      social_follow: 'social_follow',
      social_comment: 'social_comment',
      challenge_live: 'competition_challenge',
      weekly_results: 'competition_results',
      live_event_results: 'competition_results',
      live_event_reminder: 'competition_reminder',
      creator_endorsed: 'creator_application',
      creator_approved: 'creator_application',
      creator_rejected: 'creator_application',
      // Coding-practice types (Task 30)
      coding_drill_ready: 'coding_drill_ready',
      coding_calibration_invitation: 'coding_calibration_invitation',
      coding_difficulty_change_suggestion: 'coding_difficulty_change_suggestion',
      // Coding capstone types (Phase B)
      coding_capstone_available: 'coding_capstone_available',
      coding_level_up: 'coding_level_up',
      // On-demand generated capstone outcomes — reuse existing valid enum
      // values so the in-app record persists (push carries the custom copy).
      coding_capstone_generated: 'coding_capstone_available',
      coding_capstone_generation_failed: 'journey_update',
      // Institution assessments (placement). Emission is gated by
      // PLACEMENTS_NOTIFICATIONS_ENABLED at the call sites; these mappings just
      // let the in-app record persist once emission is turned on.
      assessment_assigned: 'assessment_assigned',
      assessment_results: 'assessment_results',
    };
    return map[dataType] || 'journey_update';
  }
}

module.exports = new NotificationService();
