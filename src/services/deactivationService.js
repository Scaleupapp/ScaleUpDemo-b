/**
 * Deactivation Service
 *
 * Handles account restore on reactivation and permanent deletion after 30 days.
 */

const User = require('../models/User');
const Content = require('../models/Content');
const Journey = require('../models/Journey');
const Follow = require('../models/Follow');
const Quiz = require('../models/Quiz');
const QuizAttempt = require('../models/QuizAttempt');
const UserObjective = require('../models/UserObjective');
const KnowledgeProfile = require('../models/KnowledgeProfile');
const CompetitionProfile = require('../models/CompetitionProfile');
const ContentProgress = require('../models/ContentProgress');
const ContentInteraction = require('../models/ContentInteraction');
const ConsumptionGraph = require('../models/ConsumptionGraph');
const Notification = require('../models/Notification');
const Comment = require('../models/Comment');
const Conversation = require('../models/Conversation');
const ChallengeAttempt = require('../models/ChallengeAttempt');
const CreatorApplication = require('../models/CreatorApplication');
const Playlist = require('../models/Playlist');
const AuditLog = require('../models/AuditLog');
const emailService = require('./emailService');

const GRACE_PERIOD_DAYS = 30;

class DeactivationService {

  /**
   * Restore a user's account after reactivation.
   * Reverses the cleanup done during deactivation.
   */
  async restoreAccount(userId) {
    const user = await User.findById(userId);
    if (!user) return;

    // 1. Unhide creator content — restore original status
    if (user.role === 'creator' || user.role === 'admin') {
      const deactivatedContent = await Content.find({ creatorId: userId, status: 'deactivated' });
      for (const content of deactivatedContent) {
        content.status = content._preDeactivationStatus || 'published';
        content._preDeactivationStatus = undefined;
        await content.save();
      }
    }

    // 2. Resume paused journeys (only those paused around deactivation time)
    const deactivatedAt = user.deletedAt;
    if (deactivatedAt) {
      // Resume journeys that were paused within 1 minute of deactivation
      const pauseWindow = new Date(deactivatedAt.getTime() + 60 * 1000);
      await Journey.updateMany(
        { userId, status: 'paused', pausedAt: { $lte: pauseWindow, $gte: deactivatedAt } },
        { $set: { status: 'active', pausedAt: null, lastResumedAt: new Date() } }
      );
    }

    // 3. Restore follow counts
    const [following, followers] = await Promise.all([
      Follow.find({ followerId: userId }).select('followingId').lean(),
      Follow.find({ followingId: userId }).select('followerId').lean(),
    ]);
    if (following.length > 0) {
      await User.updateMany(
        { _id: { $in: following.map(f => f.followingId) } },
        { $inc: { followersCount: 1 } }
      );
    }
    if (followers.length > 0) {
      await User.updateMany(
        { _id: { $in: followers.map(f => f.followerId) } },
        { $inc: { followingCount: 1 } }
      );
    }

    console.log(`[Reactivation] User ${userId} (${user.email}) restored. Content unhidden: ${user.role === 'creator'}, Follows restored: ${following.length + followers.length}`);
  }

  /**
   * Permanently delete accounts past the 30-day grace period.
   * Called by daily cron job.
   */
  async permanentlyDeleteExpiredAccounts() {
    const cutoffDate = new Date(Date.now() - GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);

    const expiredUsers = await User.find({
      isActive: false,
      deletedAt: { $lte: cutoffDate },
      isPermanentlyDeleted: { $ne: true },
    }).select('_id email firstName role');

    if (expiredUsers.length === 0) return 0;

    let deletedCount = 0;
    for (const user of expiredUsers) {
      try {
        await this._permanentlyDeleteUser(user._id);
        deletedCount++;
        console.log(`[PermanentDeletion] User ${user._id} (${user.email}) permanently deleted`);
      } catch (err) {
        console.error(`[PermanentDeletion] Failed for user ${user._id}:`, err.message);
      }
    }

    return deletedCount;
  }

  /**
   * Hard-anonymize a single user and delete their related data.
   */
  async _permanentlyDeleteUser(userId) {
    // Delete ALL user data across every collection
    await Promise.all([
      Content.deleteMany({ creatorId: userId }),
      Journey.deleteMany({ userId }),
      UserObjective.deleteMany({ userId }),
      Quiz.deleteMany({ userId }),
      QuizAttempt.deleteMany({ userId }),
      KnowledgeProfile.deleteMany({ userId }),
      CompetitionProfile.deleteMany({ userId }),
      ContentProgress.deleteMany({ userId }),
      ContentInteraction.deleteMany({ userId }),
      ConsumptionGraph.deleteMany({ userId }),
      Notification.deleteMany({ userId }),
      Comment.deleteMany({ userId }),
      Conversation.deleteMany({ userId }),
      ChallengeAttempt.deleteMany({ userId }),
      CreatorApplication.deleteMany({ userId }),
      Playlist.deleteMany({ userId }),
      AuditLog.deleteMany({ userId }),
      Follow.deleteMany({ $or: [{ followerId: userId }, { followingId: userId }] }),
    ]);

    // Anonymize the user document (keep shell for referential integrity)
    await User.findByIdAndUpdate(userId, {
      $set: {
        firstName: 'Deleted',
        lastName: 'User',
        email: `deleted_${userId}@removed.scaleup.local`,
        bio: '',
        profilePicture: undefined,
        phone: undefined,
        googleId: undefined,
        linkedinId: undefined,
        skills: [],
        education: [],
        workExperience: [],
        fcmToken: undefined,
        isPermanentlyDeleted: true,
      },
      $unset: { password: 1, refreshTokenHash: 1 },
    });
  }

  /**
   * Send reminder emails to users approaching permanent deletion.
   * Called by daily cron job.
   */
  async sendDeletionReminders() {
    const sevenDaysBefore = new Date(Date.now() - (GRACE_PERIOD_DAYS - 7) * 24 * 60 * 60 * 1000);
    const oneDayBefore = new Date(Date.now() - (GRACE_PERIOD_DAYS - 1) * 24 * 60 * 60 * 1000);

    // 7-day reminder: users deactivated exactly 23 days ago (±12 hours)
    const sevenDayUsers = await User.find({
      isActive: false,
      isPermanentlyDeleted: { $ne: true },
      deletedAt: {
        $gte: new Date(sevenDaysBefore.getTime() - 12 * 60 * 60 * 1000),
        $lte: new Date(sevenDaysBefore.getTime() + 12 * 60 * 60 * 1000),
      },
    }).select('email firstName');

    for (const user of sevenDayUsers) {
      try {
        await emailService.sendDeletionReminder(user.email, user.firstName, 7);
      } catch (err) {
        console.error(`[DeletionReminder] 7-day email failed for ${user.email}:`, err.message);
      }
    }

    // 1-day reminder: users deactivated exactly 29 days ago (±12 hours)
    const oneDayUsers = await User.find({
      isActive: false,
      isPermanentlyDeleted: { $ne: true },
      deletedAt: {
        $gte: new Date(oneDayBefore.getTime() - 12 * 60 * 60 * 1000),
        $lte: new Date(oneDayBefore.getTime() + 12 * 60 * 60 * 1000),
      },
    }).select('email firstName');

    for (const user of oneDayUsers) {
      try {
        await emailService.sendDeletionReminder(user.email, user.firstName, 1);
      } catch (err) {
        console.error(`[DeletionReminder] 1-day email failed for ${user.email}:`, err.message);
      }
    }

    const total = sevenDayUsers.length + oneDayUsers.length;
    if (total > 0) {
      console.log(`[DeletionReminder] Sent ${sevenDayUsers.length} 7-day and ${oneDayUsers.length} 1-day reminders`);
    }
    return total;
  }
}

module.exports = new DeactivationService();
