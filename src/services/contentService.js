const Content = require('../models/Content');
const { paginationMeta } = require('../utils/pagination');
const ApiError = require('../utils/apiError');
const { s3 } = require('../config/s3');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class ContentService {

  /**
   * Replace thumbnailURL with a presigned S3 URL for items that have thumbnailS3Key.
   * Direct S3 URLs don't work if the bucket isn't public.
   */
  async _signThumbnails(items) {
    const docs = Array.isArray(items) ? items : [items];
    await Promise.all(docs.map(async (doc) => {
      const key = doc.thumbnailS3Key;
      if (!key) return;
      try {
        const cmd = new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: key });
        const url = await getSignedUrl(s3, cmd, { expiresIn: 86400 }); // 24h
        doc.thumbnailURL = url;
      } catch { /* keep original URL */ }
    }));
    return items;
  }

  async getMyContent(creatorId, { page = 1, limit = 20, status }) {
    const filter = { creatorId };
    if (status) filter.status = status;
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      Content.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Content.countDocuments(filter),
    ]);
    await this._signThumbnails(items);
    return { items, pagination: paginationMeta(total, page, limit) };
  }

  async updateContent(creatorId, contentId, updates) {
    const content = await Content.findOne({ _id: contentId, creatorId });
    if (!content) throw new ApiError(404, 'Content not found or not yours');
    const allowed = ['title', 'description', 'domain', 'topics', 'tags', 'difficulty', 'thumbnailURL'];
    for (const key of allowed) {
      if (updates[key] !== undefined) content[key] = updates[key];
    }
    return content.save();
  }

  async publishContent(creatorId, contentId) {
    const content = await Content.findOne({ _id: contentId, creatorId });
    if (!content) throw new ApiError(404, 'Content not found');
    if (content.aiStatus !== 'completed') throw new ApiError(400, 'AI processing not complete yet');
    content.status = 'published';
    content.publishedAt = new Date();
    content.moderationStatus = 'approved';
    return content.save();
  }

  async unpublishContent(creatorId, contentId) {
    const content = await Content.findOne({ _id: contentId, creatorId });
    if (!content) throw new ApiError(404, 'Content not found');
    content.status = 'unpublished';
    return content.save();
  }

  async deleteContent(creatorId, contentId) {
    const content = await Content.findOne({ _id: contentId, creatorId });
    if (!content) throw new ApiError(404, 'Content not found or not yours');
    if (content.status === 'published') {
      throw new ApiError(400, 'Unpublish content before deleting');
    }
    await Content.deleteOne({ _id: contentId });
    return { deleted: true };
  }

  async getContent(contentId) {
    const content = await Content.findById(contentId).populate('creatorId', 'firstName lastName username profilePicture');
    if (!content) throw new ApiError(404, 'Content not found');
    await this._signThumbnails([content]);
    return content;
  }

  async getFeed(userId, { page = 1, limit = 20 }) {
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      Content.find({ status: 'published' })
        .sort({ publishedAt: -1 }).skip(skip).limit(limit)
        .populate('creatorId', 'firstName lastName username profilePicture'),
      Content.countDocuments({ status: 'published' }),
    ]);
    await this._signThumbnails(items);
    return { items, pagination: paginationMeta(total, page, limit) };
  }

  async explore({ domain, topics, difficulty, search, creatorId, page = 1, limit = 20 }) {
    const filter = { status: 'published' };
    if (domain) filter.domain = domain;
    if (topics) filter.topics = { $in: Array.isArray(topics) ? topics : [topics] };
    if (difficulty) filter.difficulty = difficulty;
    if (search) filter.title = { $regex: escapeRegex(search), $options: 'i' };
    if (creatorId) filter.creatorId = creatorId;

    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      Content.find(filter).sort({ publishedAt: -1 }).skip(skip).limit(limit)
        .populate('creatorId', 'firstName lastName username profilePicture'),
      Content.countDocuments(filter),
    ]);
    await this._signThumbnails(items);
    return { items, pagination: paginationMeta(total, page, limit) };
  }
}

module.exports = new ContentService();
