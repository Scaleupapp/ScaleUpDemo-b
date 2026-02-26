const admin = require('../config/firebase');
const User = require('../models/User');

class NotificationService {

  /**
   * Send a push notification to a specific user.
   * Silently skips if Firebase is not configured or user has no FCM token.
   */
  async sendToUser(userId, { title, body, data = {} }) {
    try {
      const user = await User.findById(userId).select('fcmToken').lean();
      if (!user || !user.fcmToken) return null;

      if (!admin.apps.length) return null;

      const message = {
        token: user.fcmToken,
        notification: { title, body },
        data: this._stringifyData(data),
      };

      return await admin.messaging().send(message);
    } catch (err) {
      // Log but don't throw — notifications are best-effort
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

    if (users.length === 0 || !admin.apps.length) return [];

    const messages = users.map(user => ({
      token: user.fcmToken,
      notification: { title, body },
      data: this._stringifyData(data),
    }));

    try {
      const response = await admin.messaging().sendEach(messages);
      return response.responses;
    } catch (err) {
      console.error('Batch push notification failed:', err.message);
      return [];
    }
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
   * Ensure all data values are strings (FCM requirement).
   */
  _stringifyData(data) {
    const result = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = String(value);
    }
    return result;
  }
}

module.exports = new NotificationService();
