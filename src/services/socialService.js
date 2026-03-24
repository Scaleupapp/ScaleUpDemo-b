const Follow = require('../models/Follow');
const ContentInteraction = require('../models/ContentInteraction');
const Comment = require('../models/Comment');
const Content = require('../models/Content');
const Playlist = require('../models/Playlist');
const User = require('../models/User');
const { paginate, paginationMeta } = require('../utils/pagination');
const ApiError = require('../utils/apiError');
const { notificationQueue } = require('../config/queue');

class SocialService {

  // ─── Follow ────────────────────────────────────────────────────────

  async followUser(followerId, followingId) {
    if (followerId === followingId) throw new ApiError(400, 'Cannot follow yourself');

    const target = await User.findById(followingId);
    if (!target) throw new ApiError(404, 'User not found');

    const existing = await Follow.findOne({ followerId, followingId });
    if (existing) throw new ApiError(409, 'Already following this user');

    await Follow.create({ followerId, followingId });
    await User.findByIdAndUpdate(followerId, { $inc: { followingCount: 1 } });
    await User.findByIdAndUpdate(followingId, { $inc: { followersCount: 1 } });

    // Notify the followed user
    const follower = await User.findById(followerId).select('firstName lastName').lean();
    const followerName = follower ? `${follower.firstName} ${follower.lastName}`.trim() : 'Someone';
    notificationQueue.add('send', {
      userId: followingId,
      title: 'New Follower',
      body: `${followerName} started following you`,
      data: { type: 'social_follow', followerId },
    }).catch(err => console.error('[Social] Failed to queue follow notification:', err.message));

    return { following: true };
  }

  async unfollowUser(followerId, followingId) {
    const deleted = await Follow.findOneAndDelete({ followerId, followingId });
    if (!deleted) throw new ApiError(404, 'Not following this user');

    await User.findByIdAndUpdate(followerId, { $inc: { followingCount: -1 } });
    await User.findByIdAndUpdate(followingId, { $inc: { followersCount: -1 } });

    return { following: false };
  }

  async getFollowers(userId, { page = 1, limit = 20 } = {}) {
    const filter = { followingId: userId };
    const total = await Follow.countDocuments(filter);
    const { query, page: p, limit: l } = paginate(
      Follow.find(filter).populate('followerId', 'firstName lastName username profilePicture'),
      { page, limit },
    );
    const followers = await query.lean();
    return { followers: followers.map(f => f.followerId), pagination: paginationMeta(total, p, l) };
  }

  async getFollowing(userId, { page = 1, limit = 20 } = {}) {
    const filter = { followerId: userId };
    const total = await Follow.countDocuments(filter);
    const { query, page: p, limit: l } = paginate(
      Follow.find(filter).populate('followingId', 'firstName lastName username profilePicture'),
      { page, limit },
    );
    const following = await query.lean();
    return { following: following.map(f => f.followingId), pagination: paginationMeta(total, p, l) };
  }

  async checkFollowStatus(followerId, followingId) {
    const existing = await Follow.findOne({ followerId, followingId }).lean();
    return !!existing;
  }

  async getMutualFollowers(currentUserId, targetUserId, limit = 3) {
    // Get IDs of people the current user follows
    const myFollowing = await Follow.find({ followerId: currentUserId }).select('followingId').lean();
    const myFollowingIds = myFollowing.map(f => f.followingId.toString());

    // Find which of them follow the target user
    const mutualFilter = {
      followingId: targetUserId,
      followerId: { $in: myFollowingIds },
    };

    const [mutuals, count] = await Promise.all([
      Follow.find(mutualFilter)
        .populate('followerId', 'firstName lastName profilePicture')
        .limit(limit)
        .lean(),
      Follow.countDocuments(mutualFilter),
    ]);

    return {
      count,
      users: mutuals.map(m => m.followerId).filter(Boolean),
    };
  }

  // ─── User Content Lists ──────────────────────────────────────────

  async getLikedContent(userId, { page = 1, limit = 20 } = {}) {
    const filter = { userId, type: 'like' };
    const total = await ContentInteraction.countDocuments(filter);
    const { query, page: p, limit: l } = paginate(
      ContentInteraction.find(filter)
        .sort({ createdAt: -1 })
        .populate({
          path: 'contentId',
          populate: { path: 'creatorId', select: 'firstName lastName username profilePicture' }
        }),
      { page, limit },
    );
    const interactions = await query.lean();
    const items = interactions.map(i => i.contentId).filter(Boolean);
    return { items, pagination: paginationMeta(total, p, l) };
  }

  async getSavedContent(userId, { page = 1, limit = 20 } = {}) {
    const filter = { userId, type: 'save' };
    const total = await ContentInteraction.countDocuments(filter);
    const { query, page: p, limit: l } = paginate(
      ContentInteraction.find(filter)
        .sort({ createdAt: -1 })
        .populate({
          path: 'contentId',
          populate: { path: 'creatorId', select: 'firstName lastName username profilePicture' }
        }),
      { page, limit },
    );
    const interactions = await query.lean();
    const items = interactions.map(i => i.contentId).filter(Boolean);
    return { items, pagination: paginationMeta(total, p, l) };
  }

  // ─── Content Interactions (used by contentController) ──────────────

  async toggleLike(userId, contentId) {
    const content = await Content.findById(contentId);
    if (!content) throw new ApiError(404, 'Content not found');

    const existing = await ContentInteraction.findOne({ userId, contentId, type: 'like' });
    if (existing) {
      await ContentInteraction.deleteOne({ _id: existing._id });
      content.likeCount = Math.max(0, content.likeCount - 1);
      await content.save();
      return { liked: false, likeCount: content.likeCount };
    }

    await ContentInteraction.create({ userId, contentId, type: 'like' });
    content.likeCount += 1;
    await content.save();
    return { liked: true, likeCount: content.likeCount };
  }

  async toggleSave(userId, contentId) {
    const content = await Content.findById(contentId);
    if (!content) throw new ApiError(404, 'Content not found');

    const existing = await ContentInteraction.findOne({ userId, contentId, type: 'save' });
    if (existing) {
      await ContentInteraction.deleteOne({ _id: existing._id });
      content.saveCount = Math.max(0, content.saveCount - 1);
      await content.save();
      return { saved: false, saveCount: content.saveCount };
    }

    await ContentInteraction.create({ userId, contentId, type: 'save' });
    content.saveCount += 1;
    await content.save();
    return { saved: true, saveCount: content.saveCount };
  }

  async rateContent(userId, contentId, value) {
    if (!value || value < 1 || value > 5) throw new ApiError(400, 'Rating must be between 1 and 5');

    const content = await Content.findById(contentId);
    if (!content) throw new ApiError(404, 'Content not found');

    const existing = await ContentInteraction.findOne({ userId, contentId, type: 'rate' });
    const oldValue = existing ? existing.value : null;

    if (existing) {
      existing.value = value;
      await existing.save();
    } else {
      await ContentInteraction.create({ userId, contentId, type: 'rate', value });
    }

    if (oldValue !== null) {
      const totalRating = content.averageRating * content.ratingCount - oldValue + value;
      content.averageRating = totalRating / content.ratingCount;
    } else {
      const totalRating = content.averageRating * content.ratingCount + value;
      content.ratingCount += 1;
      content.averageRating = totalRating / content.ratingCount;
    }
    await content.save();

    return { rating: value, averageRating: content.averageRating, ratingCount: content.ratingCount };
  }

  async trackShare(userId, contentId) {
    const content = await Content.findById(contentId);
    if (!content) throw new ApiError(404, 'Content not found');

    await ContentInteraction.findOneAndUpdate(
      { userId, contentId, type: 'share' },
      { userId, contentId, type: 'share' },
      { upsert: true },
    );

    content.shareCount = (content.shareCount || 0) + 1;
    await content.save();

    return { shared: true, shareCount: content.shareCount };
  }

  // ─── Comments ──────────────────────────────────────────────────────

  async addComment(userId, contentId, { text, parentId } = {}) {
    const content = await Content.findById(contentId);
    if (!content) throw new ApiError(404, 'Content not found');
    if (!text || text.trim().length === 0) throw new ApiError(400, 'Comment text is required');

    if (parentId) {
      const parent = await Comment.findById(parentId);
      if (!parent || parent.contentId.toString() !== contentId) {
        throw new ApiError(404, 'Parent comment not found');
      }
    }

    const comment = await Comment.create({
      userId, contentId, parentId: parentId || undefined, text: text.trim(),
    });

    content.commentCount += 1;
    await content.save();

    // Notify content creator (if commenter is not the creator)
    if (content.creatorId && content.creatorId.toString() !== userId) {
      const commenter = await User.findById(userId).select('firstName lastName').lean();
      const commenterName = commenter ? `${commenter.firstName} ${commenter.lastName}`.trim() : 'Someone';
      const preview = text.trim().length > 50 ? text.trim().substring(0, 50) + '…' : text.trim();
      notificationQueue.add('send', {
        userId: content.creatorId.toString(),
        title: 'New Comment',
        body: `${commenterName} commented: "${preview}"`,
        data: { type: 'social_comment', contentId, commentId: comment._id.toString() },
      }).catch(err => console.error('[Social] Failed to queue comment notification:', err.message));
    }

    return comment;
  }

  async getComments(contentId, { page = 1, limit = 20 } = {}) {
    const filter = { contentId, deletedAt: { $exists: false } };
    const total = await Comment.countDocuments(filter);
    const { query, page: p, limit: l } = paginate(
      Comment.find(filter).sort({ createdAt: -1 }).populate('userId', 'firstName lastName username profilePicture'),
      { page, limit },
    );
    const comments = await query.lean();
    return { comments, pagination: paginationMeta(total, p, l) };
  }

  async deleteComment(userId, commentId) {
    const comment = await Comment.findById(commentId);
    if (!comment) throw new ApiError(404, 'Comment not found');
    if (comment.userId.toString() !== userId) throw new ApiError(403, 'Not your comment');

    comment.deletedAt = new Date();
    comment.text = '[deleted]';
    await comment.save();

    await Content.findByIdAndUpdate(comment.contentId, { $inc: { commentCount: -1 } });

    return { deleted: true };
  }

  // ─── Playlists ─────────────────────────────────────────────────────

  async createPlaylist(userId, { title, description, isPublic }) {
    return Playlist.create({ userId, title, description, isPublic: isPublic ?? false });
  }

  async getMyPlaylists(userId) {
    return Playlist.find({ userId }).sort({ updatedAt: -1 }).lean();
  }

  async getPlaylist(playlistId) {
    const playlist = await Playlist.findById(playlistId)
      .populate('items.contentId', 'title description contentType domain thumbnailURL duration creatorId')
      .lean();
    if (!playlist) throw new ApiError(404, 'Playlist not found');
    return playlist;
  }

  async updatePlaylist(userId, playlistId, updates) {
    const playlist = await Playlist.findOne({ _id: playlistId, userId });
    if (!playlist) throw new ApiError(404, 'Playlist not found');

    const allowed = ['title', 'description', 'isPublic'];
    for (const key of allowed) {
      if (updates[key] !== undefined) playlist[key] = updates[key];
    }
    return playlist.save();
  }

  async addToPlaylist(userId, playlistId, contentId) {
    const playlist = await Playlist.findOne({ _id: playlistId, userId });
    if (!playlist) throw new ApiError(404, 'Playlist not found');

    const content = await Content.findById(contentId);
    if (!content) throw new ApiError(404, 'Content not found');

    const alreadyIn = playlist.items.some(i => i.contentId.toString() === contentId);
    if (alreadyIn) throw new ApiError(409, 'Content already in playlist');

    const nextOrder = playlist.items.length;
    playlist.items.push({ contentId, order: nextOrder });
    playlist.itemCount = playlist.items.length;
    playlist.totalDuration += content.duration || 0;
    return playlist.save();
  }

  async removeFromPlaylist(userId, playlistId, contentId) {
    const playlist = await Playlist.findOne({ _id: playlistId, userId });
    if (!playlist) throw new ApiError(404, 'Playlist not found');

    const idx = playlist.items.findIndex(i => i.contentId.toString() === contentId);
    if (idx === -1) throw new ApiError(404, 'Content not in playlist');

    const removed = playlist.items.splice(idx, 1);
    playlist.itemCount = playlist.items.length;

    const content = await Content.findById(contentId);
    if (content) playlist.totalDuration = Math.max(0, playlist.totalDuration - (content.duration || 0));

    // Reorder remaining items
    playlist.items.forEach((item, i) => { item.order = i; });

    return playlist.save();
  }

  async deletePlaylist(userId, playlistId) {
    const deleted = await Playlist.findOneAndDelete({ _id: playlistId, userId });
    if (!deleted) throw new ApiError(404, 'Playlist not found');
    return { deleted: true };
  }
}

module.exports = new SocialService();
