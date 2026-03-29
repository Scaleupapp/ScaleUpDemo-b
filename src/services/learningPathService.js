const LearningPath = require('../models/LearningPath');
const Content = require('../models/Content');
const User = require('../models/User');
const { paginate, paginationMeta } = require('../utils/pagination');
const ApiError = require('../utils/apiError');

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class LearningPathService {

  // ─── Create ────────────────────────────────────────────────────────

  async createPath(userId, data) {
    const user = await User.findById(userId);
    if (!user) throw new ApiError(404, 'User not found');

    // Determine creatorType based on user role
    const creatorType = user.role === 'creator' ? 'creator' : 'consumer';

    // Validate all content items exist
    if (data.items && data.items.length > 0) {
      const contentIds = data.items.map(i => i.contentId);
      const validContent = await Content.countDocuments({ _id: { $in: contentIds }, status: 'published' });
      if (validContent !== contentIds.length) {
        throw new ApiError(400, 'One or more content items are invalid or not published');
      }
    }

    const path = await LearningPath.create({
      createdBy: userId,
      creatorType,
      title: data.title,
      description: data.description,
      domain: data.domain,
      topics: data.topics || [],
      difficulty: data.difficulty || 'mixed',
      estimatedHours: data.estimatedHours,
      targetObjectiveType: data.targetObjectiveType,
      targetSpecifics: data.targetSpecifics,
      items: (data.items || []).map((item, idx) => ({
        contentId: item.contentId,
        order: item.order ?? idx,
        note: item.note,
        isOptional: item.isOptional || false,
      })),
      totalItems: (data.items || []).length,
      status: 'draft',
    });

    return path;
  }

  // ─── Update ────────────────────────────────────────────────────────

  async updatePath(userId, pathId, updates) {
    const path = await LearningPath.findOne({ _id: pathId, createdBy: userId });
    if (!path) throw new ApiError(404, 'Learning path not found');

    const allowed = ['title', 'description', 'domain', 'topics', 'difficulty',
      'estimatedHours', 'targetObjectiveType', 'targetSpecifics', 'isPublic'];
    for (const key of allowed) {
      if (updates[key] !== undefined) path[key] = updates[key];
    }

    return path.save();
  }

  // ─── Items Management ─────────────────────────────────────────────

  async addItem(userId, pathId, { contentId, note, isOptional }) {
    const path = await LearningPath.findOne({ _id: pathId, createdBy: userId });
    if (!path) throw new ApiError(404, 'Learning path not found');

    const content = await Content.findById(contentId);
    if (!content || content.status !== 'published') {
      throw new ApiError(400, 'Content is not available');
    }

    const alreadyIn = path.items.some(i => i.contentId.toString() === contentId);
    if (alreadyIn) throw new ApiError(409, 'Content already in this path');

    path.items.push({
      contentId,
      order: path.items.length,
      note,
      isOptional: isOptional || false,
    });
    path.totalItems = path.items.length;
    return path.save();
  }

  async removeItem(userId, pathId, contentId) {
    const path = await LearningPath.findOne({ _id: pathId, createdBy: userId });
    if (!path) throw new ApiError(404, 'Learning path not found');

    const idx = path.items.findIndex(i => i.contentId.toString() === contentId);
    if (idx === -1) throw new ApiError(404, 'Content not in this path');

    path.items.splice(idx, 1);
    path.items.forEach((item, i) => { item.order = i; });
    path.totalItems = path.items.length;
    return path.save();
  }

  async reorderItems(userId, pathId, orderedContentIds) {
    const path = await LearningPath.findOne({ _id: pathId, createdBy: userId });
    if (!path) throw new ApiError(404, 'Learning path not found');

    const itemMap = new Map(path.items.map(i => [i.contentId.toString(), i]));
    const reordered = [];
    for (let i = 0; i < orderedContentIds.length; i++) {
      const item = itemMap.get(orderedContentIds[i]);
      if (!item) throw new ApiError(400, `Content ${orderedContentIds[i]} not found in path`);
      item.order = i;
      reordered.push(item);
    }
    path.items = reordered;
    return path.save();
  }

  // ─── Publish / Archive ────────────────────────────────────────────

  async publishPath(userId, pathId) {
    const path = await LearningPath.findOne({ _id: pathId, createdBy: userId });
    if (!path) throw new ApiError(404, 'Learning path not found');
    if (path.items.length === 0) throw new ApiError(400, 'Cannot publish an empty learning path');

    path.status = 'published';
    path.publishedAt = new Date();
    return path.save();
  }

  async archivePath(userId, pathId) {
    const path = await LearningPath.findOne({ _id: pathId, createdBy: userId });
    if (!path) throw new ApiError(404, 'Learning path not found');

    path.status = 'archived';
    return path.save();
  }

  // ─── Read ──────────────────────────────────────────────────────────

  async getMyPaths(userId, { page = 1, limit = 20 } = {}) {
    const filter = { createdBy: userId };
    const total = await LearningPath.countDocuments(filter);
    const { query, page: p, limit: l } = paginate(
      LearningPath.find(filter).sort({ updatedAt: -1 }),
      { page, limit },
    );
    const paths = await query.lean();
    return { paths, pagination: paginationMeta(total, p, l) };
  }

  async getPath(pathId) {
    const path = await LearningPath.findById(pathId)
      .populate('createdBy', 'firstName lastName username profilePicture')
      .populate('items.contentId', 'title description contentType domain thumbnailURL duration creatorId')
      .lean();
    if (!path) throw new ApiError(404, 'Learning path not found');
    return path;
  }

  async explorePaths({ domain, objectiveType, difficulty, creatorType, search, page = 1, limit = 20 } = {}) {
    const filter = { status: 'published', isPublic: true };

    if (domain) filter.domain = domain.toLowerCase();
    if (objectiveType) filter.targetObjectiveType = objectiveType;
    if (difficulty) filter.difficulty = difficulty;
    if (creatorType) filter.creatorType = creatorType;
    if (search) filter.title = { $regex: escapeRegex(search), $options: 'i' };

    const total = await LearningPath.countDocuments(filter);
    const { query, page: p, limit: l } = paginate(
      LearningPath.find(filter)
        .sort({ followerCount: -1, createdAt: -1 })
        .populate('createdBy', 'firstName lastName username profilePicture'),
      { page, limit },
    );
    const paths = await query.lean();
    return { paths, pagination: paginationMeta(total, p, l) };
  }

  // ─── Follow / Rate ────────────────────────────────────────────────

  async followPath(userId, pathId) {
    const path = await LearningPath.findById(pathId);
    if (!path) throw new ApiError(404, 'Learning path not found');
    path.followerCount += 1;
    await path.save();
    return { followed: true, followerCount: path.followerCount };
  }

  async unfollowPath(userId, pathId) {
    const path = await LearningPath.findById(pathId);
    if (!path) throw new ApiError(404, 'Learning path not found');
    path.followerCount = Math.max(0, path.followerCount - 1);
    await path.save();
    return { followed: false, followerCount: path.followerCount };
  }

  async ratePath(userId, pathId, rating) {
    if (!rating || rating < 1 || rating > 5) throw new ApiError(400, 'Rating must be between 1 and 5');

    const path = await LearningPath.findById(pathId);
    if (!path) throw new ApiError(404, 'Learning path not found');

    const totalRating = path.averageRating * path.ratingCount + rating;
    path.ratingCount += 1;
    path.averageRating = totalRating / path.ratingCount;
    await path.save();

    return { rating, averageRating: path.averageRating, ratingCount: path.ratingCount };
  }
}

module.exports = new LearningPathService();
