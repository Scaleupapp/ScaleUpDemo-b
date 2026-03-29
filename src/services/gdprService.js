/**
 * GDPR Service
 *
 * Handles data export (Article 15/20), audit logging (Article 30),
 * and breach notification (Articles 33/34).
 */

const User = require('../models/User');
const Content = require('../models/Content');
const ContentProgress = require('../models/ContentProgress');
const ContentInteraction = require('../models/ContentInteraction');
const Journey = require('../models/Journey');
const UserObjective = require('../models/UserObjective');
const Quiz = require('../models/Quiz');
const QuizAttempt = require('../models/QuizAttempt');
const KnowledgeProfile = require('../models/KnowledgeProfile');
const CompetitionProfile = require('../models/CompetitionProfile');
const ConsumptionGraph = require('../models/ConsumptionGraph');
const Conversation = require('../models/Conversation');
const Comment = require('../models/Comment');
const Follow = require('../models/Follow');
const Notification = require('../models/Notification');
const Playlist = require('../models/Playlist');
const ChallengeAttempt = require('../models/ChallengeAttempt');
const CreatorApplication = require('../models/CreatorApplication');
const AuditLog = require('../models/AuditLog');
const emailService = require('./emailService');

class GDPRService {

  /**
   * Export ALL user data as a structured JSON object (Articles 15 & 20).
   */
  async exportUserData(userId) {
    const [
      user, content, contentProgress, contentInteractions,
      journeys, objectives, quizzes, quizAttempts,
      knowledgeProfile, competitionProfile, consumptionGraph,
      conversations, comments, followers, following,
      notifications, playlists, challengeAttempts, creatorApplications,
    ] = await Promise.all([
      User.findById(userId).select('-password -refreshTokenHash -__v').lean(),
      Content.find({ creatorId: userId }).select('-__v').lean(),
      ContentProgress.find({ userId }).select('-__v').lean(),
      ContentInteraction.find({ userId }).select('-__v').lean(),
      Journey.find({ userId }).select('-__v').lean(),
      UserObjective.find({ userId }).select('-__v').lean(),
      Quiz.find({ userId }).select('-__v').lean(),
      QuizAttempt.find({ userId }).select('-__v').lean(),
      KnowledgeProfile.findOne({ userId }).select('-__v').lean(),
      CompetitionProfile.findOne({ userId }).select('-__v').lean(),
      ConsumptionGraph.findOne({ userId }).select('-__v').lean(),
      Conversation.find({ userId }).select('-__v').lean(),
      Comment.find({ userId }).select('-__v').lean(),
      Follow.find({ followingId: userId }).populate('followerId', 'firstName lastName username').lean(),
      Follow.find({ followerId: userId }).populate('followingId', 'firstName lastName username').lean(),
      Notification.find({ userId }).select('-__v').lean(),
      Playlist.find({ userId }).select('-__v').lean(),
      ChallengeAttempt.find({ userId }).select('-__v').lean(),
      CreatorApplication.find({ userId }).select('-__v').lean(),
    ]);

    return {
      metadata: {
        exportDate: new Date().toISOString(),
        dataController: 'ScaleUp Technologies',
        contactEmail: 'privacy@scaleupapp.com',
        legalBasis: 'GDPR Article 15 — Right of Access / Article 20 — Right to Data Portability',
        format: 'JSON',
        userId,
      },
      profile: user,
      createdContent: content,
      learningProgress: contentProgress,
      contentInteractions,
      learningJourneys: journeys,
      objectives,
      quizzes,
      quizAttempts,
      knowledgeProfile,
      competitionProfile,
      consumptionGraph,
      aiConversations: conversations,
      comments,
      socialGraph: {
        followers: followers.map(f => f.followerId),
        following: following.map(f => f.followingId),
      },
      notifications,
      playlists,
      competitionAttempts: challengeAttempts,
      creatorApplications,
    };
  }

  /**
   * Log an auditable action (Article 30 — Records of Processing).
   */
  async logAction({ userId, action, category, details, ip, userAgent }) {
    try {
      await AuditLog.create({
        userId,
        action,
        category,
        details,
        ip,
        userAgent,
        timestamp: new Date(),
      });
    } catch (err) {
      // Audit logging must never crash the request
      console.error('[AuditLog] Failed to log:', err.message);
    }
  }

  /**
   * Get audit log for a user (admin or self-service).
   */
  async getAuditLog(userId, { page = 1, limit = 50 } = {}) {
    const skip = (page - 1) * limit;
    const [logs, total] = await Promise.all([
      AuditLog.find({ userId }).sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
      AuditLog.countDocuments({ userId }),
    ]);
    return { logs, total, page, limit };
  }

  /**
   * Notify all affected users of a data breach (Article 33/34).
   * Called by admin when a breach is detected.
   */
  async notifyBreach({ title, description, dataAffected, actionRequired, affectedUserIds }) {
    let userQuery = {};
    if (affectedUserIds && affectedUserIds.length > 0) {
      userQuery = { _id: { $in: affectedUserIds }, isActive: true };
    } else {
      // Notify all active users
      userQuery = { isActive: true, isPermanentlyDeleted: { $ne: true } };
    }

    const users = await User.find(userQuery).select('email firstName').lean();
    let sent = 0;
    let failed = 0;

    for (const user of users) {
      try {
        await emailService.sendBreachNotification(user.email, user.firstName, {
          title,
          description,
          dataAffected,
          actionRequired,
        });
        sent++;
      } catch (err) {
        console.error(`[BreachNotification] Failed for ${user.email}:`, err.message);
        failed++;
      }
    }

    // Log the breach notification event
    await this.logAction({
      userId: 'system',
      action: 'breach_notification_sent',
      category: 'security',
      details: { title, usersNotified: sent, usersFailed: failed, totalAffected: users.length },
    });

    return { sent, failed, total: users.length };
  }
}

module.exports = new GDPRService();
