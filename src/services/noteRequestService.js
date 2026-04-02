const NoteRequest = require('../models/NoteRequest');
const NoteRequestUpvote = require('../models/NoteRequestUpvote');
const User = require('../models/User');
const ApiError = require('../utils/apiError');
const { paginationMeta } = require('../utils/pagination');

class NoteRequestService {

  async createRequest(userId, data) {
    const request = await NoteRequest.create({
      requestedBy: userId,
      title: data.title,
      description: data.description,
      domain: data.domain,
      topics: data.topics || [],
      difficulty: data.difficulty,
      collegeName: data.collegeName,
    });
    return request;
  }

  async listRequests({ domain, status, sort = 'recent', page = 1, limit = 20 } = {}) {
    const filter = {};
    if (domain) filter.domain = domain.toLowerCase();
    if (status) filter.status = status;
    else filter.status = { $in: ['open', 'in_progress'] };

    const sortObj = sort === 'upvotes'
      ? { upvoteCount: -1, createdAt: -1 }
      : { createdAt: -1 };

    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      NoteRequest.find(filter)
        .populate('requestedBy', 'firstName lastName username profilePicture')
        .populate('fulfilledBy', 'firstName lastName username')
        .populate('fulfilledContentId', 'title thumbnailURL')
        .sort(sortObj)
        .skip(skip)
        .limit(limit)
        .lean(),
      NoteRequest.countDocuments(filter),
    ]);

    return { items, pagination: paginationMeta(total, page, limit) };
  }

  async getRequest(id) {
    const request = await NoteRequest.findById(id)
      .populate('requestedBy', 'firstName lastName username profilePicture')
      .populate('fulfilledBy', 'firstName lastName username profilePicture')
      .populate('fulfilledContentId', 'title thumbnailURL domain')
      .lean();
    if (!request) throw new ApiError(404, 'Note request not found');
    return request;
  }

  async toggleUpvote(userId, requestId) {
    const request = await NoteRequest.findById(requestId);
    if (!request) throw new ApiError(404, 'Note request not found');

    const existing = await NoteRequestUpvote.findOne({ userId, noteRequestId: requestId });
    if (existing) {
      await NoteRequestUpvote.deleteOne({ _id: existing._id });
      request.upvoteCount = Math.max(0, request.upvoteCount - 1);
      await request.save();
      return { upvoted: false, upvoteCount: request.upvoteCount };
    } else {
      await NoteRequestUpvote.create({ userId, noteRequestId: requestId });
      request.upvoteCount += 1;
      await request.save();
      return { upvoted: true, upvoteCount: request.upvoteCount };
    }
  }

  async claimRequest(userId, requestId) {
    const request = await NoteRequest.findById(requestId);
    if (!request) throw new ApiError(404, 'Note request not found');
    if (request.status !== 'open') throw new ApiError(400, 'Request is no longer open');

    request.status = 'in_progress';
    request.responseCount += 1;
    await request.save();

    // Notify requester
    try {
      const { notificationQueue } = require('../config/queue');
      await notificationQueue.add('send', {
        userId: request.requestedBy.toString(),
        title: 'Someone is working on your request!',
        body: `A contributor started working on "${request.title}".`,
        data: { type: 'note_request_claimed', noteRequestId: requestId },
      });
    } catch {}

    return request;
  }

  async fulfillRequest(userId, requestId, contentId) {
    const request = await NoteRequest.findById(requestId);
    if (!request) throw new ApiError(404, 'Note request not found');
    if (request.status === 'fulfilled') throw new ApiError(400, 'Request already fulfilled');

    request.status = 'fulfilled';
    request.fulfilledBy = userId;
    request.fulfilledContentId = contentId;
    request.fulfilledAt = new Date();
    await request.save();

    // Update contributor stats
    await User.findByIdAndUpdate(userId, {
      $inc: { 'contributorStats.requestsFulfilled': 1 },
    });

    // Notify requester
    try {
      const { notificationQueue } = require('../config/queue');
      await notificationQueue.add('send', {
        userId: request.requestedBy.toString(),
        title: 'Your note request has been fulfilled!',
        body: `Someone uploaded notes for "${request.title}". Check it out!`,
        data: { type: 'note_request_fulfilled', noteRequestId: requestId, contentId },
      });
    } catch {}

    return request;
  }

  async getMyRequests(userId, { page = 1, limit = 20 } = {}) {
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      NoteRequest.find({ requestedBy: userId })
        .populate('fulfilledBy', 'firstName lastName username')
        .populate('fulfilledContentId', 'title thumbnailURL')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      NoteRequest.countDocuments({ requestedBy: userId }),
    ]);
    return { items, pagination: paginationMeta(total, page, limit) };
  }

  async deleteRequest(userId, requestId) {
    const request = await NoteRequest.findById(requestId);
    if (!request) throw new ApiError(404, 'Note request not found');
    if (request.requestedBy.toString() !== userId) throw new ApiError(403, 'Not your request');
    if (request.status !== 'open') throw new ApiError(400, 'Can only delete open requests');

    await NoteRequest.deleteOne({ _id: requestId });
    await NoteRequestUpvote.deleteMany({ noteRequestId: requestId });
    return { deleted: true };
  }

  async isUpvotedByUser(userId, requestId) {
    const upvote = await NoteRequestUpvote.findOne({ userId, noteRequestId: requestId });
    return !!upvote;
  }
}

module.exports = new NoteRequestService();
