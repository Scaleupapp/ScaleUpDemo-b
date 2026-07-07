const mongoose = require('mongoose');
const Block = require('../models/Block');
const Report = require('../models/Report');
const Follow = require('../models/Follow');
const User = require('../models/User');
const Comment = require('../models/Comment');
const NoteRequest = require('../models/NoteRequest');
const Content = require('../models/Content');
const ApiError = require('../utils/apiError');
const emailService = require('./emailService');

class ModerationService {
  /**
   * All user ids that should be hidden from `userId`'s feeds — i.e. everyone
   * they've blocked AND everyone who has blocked them (bidirectional). Returned
   * as an array of ObjectIds suitable for a `$nin` filter.
   */
  async getBlockedIds(userId) {
    if (!userId) return [];
    const uid = String(userId);
    const blocks = await Block.find({
      $or: [{ blockerId: userId }, { blockedId: userId }],
    }).select('blockerId blockedId').lean();
    const set = new Set();
    for (const b of blocks) {
      set.add(String(b.blockerId) === uid ? String(b.blockedId) : String(b.blockerId));
    }
    return [...set].map((id) => new mongoose.Types.ObjectId(id));
  }

  async _recountFollows(userId) {
    const [followers, following] = await Promise.all([
      Follow.countDocuments({ followingId: userId }),
      Follow.countDocuments({ followerId: userId }),
    ]);
    await User.findByIdAndUpdate(userId, { followersCount: followers, followingCount: following });
  }

  async blockUser(blockerId, blockedId) {
    if (String(blockerId) === String(blockedId)) {
      throw new ApiError(400, 'You cannot block yourself');
    }
    const target = await User.findById(blockedId).select('_id firstName lastName');
    if (!target) throw new ApiError(404, 'User not found');

    await Block.updateOne(
      { blockerId, blockedId },
      { $setOnInsert: { blockerId, blockedId } },
      { upsert: true },
    );

    // Remove any follow relationship in both directions and fix counters so
    // the blocked user disappears from social lists immediately.
    await Follow.deleteMany({
      $or: [
        { followerId: blockerId, followingId: blockedId },
        { followerId: blockedId, followingId: blockerId },
      ],
    });
    await Promise.all([this._recountFollows(blockerId), this._recountFollows(blockedId)]);

    // Notify the developer/admins (non-fatal).
    this._notifyAdmins(
      'ScaleUp: a user was blocked',
      `User ${blockerId} blocked user ${blockedId} (${target.firstName || ''} ${target.lastName || ''}). Review recent activity by the blocked user for objectionable content.`,
    ).catch(() => {});

    return { blocked: true };
  }

  async unblockUser(blockerId, blockedId) {
    await Block.deleteOne({ blockerId, blockedId });
    return { blocked: false };
  }

  async listBlocked(userId) {
    const blocks = await Block.find({ blockerId: userId })
      .sort({ createdAt: -1 })
      .populate('blockedId', 'firstName lastName username profilePicture')
      .lean();
    return blocks
      .filter((b) => b.blockedId)
      .map((b) => ({
        id: b.blockedId._id,
        firstName: b.blockedId.firstName,
        lastName: b.blockedId.lastName,
        username: b.blockedId.username,
        profilePicture: b.blockedId.profilePicture,
        blockedAt: b.createdAt,
      }));
  }

  async isBlockedEitherWay(a, b) {
    const found = await Block.exists({
      $or: [
        { blockerId: a, blockedId: b },
        { blockerId: b, blockedId: a },
      ],
    });
    return !!found;
  }

  async _resolveTargetUser(targetType, targetId) {
    try {
      if (targetType === 'user') return targetId;
      if (targetType === 'comment') return (await Comment.findById(targetId).select('userId'))?.userId;
      if (targetType === 'noteRequest') return (await NoteRequest.findById(targetId).select('requestedBy'))?.requestedBy;
      if (targetType === 'content') return (await Content.findById(targetId).select('creatorId'))?.creatorId;
    } catch (_) { /* ignore */ }
    return undefined;
  }

  async report({ reporterId, targetType, targetId, reason, description }) {
    if (!targetType || !targetId || !reason) {
      throw new ApiError(400, 'targetType, targetId and reason are required');
    }
    const targetUserId = await this._resolveTargetUser(targetType, targetId);
    try {
      await Report.create({ reporterId, targetType, targetId, targetUserId, reason, description });
    } catch (e) {
      if (e.code === 11000) return { reported: true, duplicate: true }; // already reported
      throw e;
    }
    this._notifyAdmins(
      `ScaleUp: ${targetType} reported (${reason})`,
      `User ${reporterId} reported ${targetType} ${targetId}` +
        (targetUserId ? ` by user ${targetUserId}` : '') +
        `.\nReason: ${reason}\n${description ? 'Details: ' + description : ''}`,
    ).catch(() => {});
    return { reported: true };
  }

  async _notifyAdmins(subject, body) {
    const admins = await User.find({ role: 'admin', isActive: true }).select('email').lean();
    const emails = admins.map((a) => a.email).filter(Boolean);
    if (!emails.length) return;
    await emailService.sendBasic(emails.join(','), subject, `<p>${body.replace(/\n/g, '<br>')}</p>`);
  }
}

module.exports = new ModerationService();
