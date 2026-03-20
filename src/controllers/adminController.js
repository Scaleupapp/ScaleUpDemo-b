const creatorService = require('../services/creatorService');
const User = require('../models/User');
const Content = require('../models/Content');
const ContentReport = require('../models/ContentReport');
const CreatorProfile = require('../models/CreatorProfile');
const CreatorApplication = require('../models/CreatorApplication');
const apiResponse = require('../utils/apiResponse');

const getPendingApplications = async (req, res, next) => {
  try {
    const data = await creatorService.getPendingApplications(req.query);
    res.json(apiResponse.paginated(data.items, data.pagination));
  } catch (err) { next(err); }
};

const rejectApplication = async (req, res, next) => {
  try {
    const app = await creatorService.adminRejectApplication(req.params.id, req.user.userId, req.body);
    res.json(apiResponse.success(app, 'Application rejected'));
  } catch (err) { next(err); }
};

const getUsers = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const filter = {};
    if (req.query.role) filter.role = req.query.role;
    if (req.query.search) {
      filter.$or = [
        { firstName: { $regex: req.query.search, $options: 'i' } },
        { lastName: { $regex: req.query.search, $options: 'i' } },
        { email: { $regex: req.query.search, $options: 'i' } },
        { username: { $regex: req.query.search, $options: 'i' } },
      ];
    }
    const [users, total] = await Promise.all([
      User.find(filter)
        .select('firstName lastName username email profilePicture role isActive isBanned createdAt lastLoginAt')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      User.countDocuments(filter),
    ]);
    const totalPages = Math.ceil(total / limit);
    res.json(apiResponse.paginated(users, {
      total, page, limit, totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    }));
  } catch (err) { next(err); }
};

const banUser = async (req, res, next) => {
  try {
    const user = await User.findByIdAndUpdate(req.params.id, { isBanned: true }, { new: true });
    res.json(apiResponse.success(user, 'User banned'));
  } catch (err) { next(err); }
};

const unbanUser = async (req, res, next) => {
  try {
    const user = await User.findByIdAndUpdate(req.params.id, { isBanned: false }, { new: true });
    res.json(apiResponse.success(user, 'User unbanned'));
  } catch (err) { next(err); }
};

const moderateContent = async (req, res, next) => {
  try {
    const { moderationStatus, moderationNote } = req.body;
    const content = await Content.findByIdAndUpdate(req.params.id, {
      moderationStatus, moderationNote, moderatedBy: req.user.userId,
    }, { new: true });
    if (moderationStatus === 'approved') {
      content.status = 'published';
      content.publishedAt = new Date();
      await content.save();
    } else if (moderationStatus === 'rejected') {
      content.status = 'rejected';
      await content.save();
    }
    res.json(apiResponse.success(content));
  } catch (err) { next(err); }
};

const getStats = async (req, res, next) => {
  try {
    const [totalUsers, totalCreators, totalContent, publishedContent, reportedContent, pendingApplications, bannedUsers] = await Promise.all([
      User.countDocuments({ isActive: true }),
      User.countDocuments({ role: 'creator' }),
      Content.countDocuments(),
      Content.countDocuments({ status: 'published' }),
      Content.countDocuments({ reportCount: { $gte: 3 }, status: { $ne: 'removed' } }),
      CreatorApplication.countDocuments({ status: 'pending' }),
      User.countDocuments({ isBanned: true }),
    ]);
    res.json(apiResponse.success({
      totalUsers, totalCreators, totalContent, publishedContent,
      reportedContent, pendingApplications, bannedUsers,
    }));
  } catch (err) { next(err); }
};

const promoteCreator = async (req, res, next) => {
  try {
    const { tier } = req.body;
    if (!['rising', 'core', 'anchor'].includes(tier)) {
      return res.status(400).json(apiResponse.error('Tier must be rising, core, or anchor'));
    }
    const profile = await CreatorProfile.findOneAndUpdate(
      { userId: req.params.id },
      { tier },
      { new: true }
    );
    if (!profile) return res.status(404).json(apiResponse.error('Creator profile not found'));
    res.json(apiResponse.success(profile, `Creator tier updated to ${tier}`));
  } catch (err) { next(err); }
};

// --- Content Moderation (new) ---

const getContent = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.minReports) filter.reportCount = { $gte: parseInt(req.query.minReports) };
    if (req.query.search) {
      filter.title = { $regex: req.query.search, $options: 'i' };
    }
    const [items, total] = await Promise.all([
      Content.find(filter)
        .populate('creatorId', 'firstName lastName username profilePicture')
        .sort({ reportCount: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Content.countDocuments(filter),
    ]);
    const totalPages = Math.ceil(total / limit);
    res.json(apiResponse.paginated(items, {
      total, page, limit, totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    }));
  } catch (err) { next(err); }
};

const removeContent = async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json(apiResponse.error('Removal reason is required'));
    const content = await Content.findByIdAndUpdate(req.params.id, {
      status: 'removed',
      removalReason: reason,
      removedAt: new Date(),
      removedBy: req.user.userId,
    }, { new: true });
    if (!content) return res.status(404).json(apiResponse.error('Content not found'));
    res.json(apiResponse.success(content, 'Content removed'));
  } catch (err) { next(err); }
};

const dismissReports = async (req, res, next) => {
  try {
    await ContentReport.deleteMany({ contentId: req.params.id });
    const content = await Content.findByIdAndUpdate(req.params.id, { reportCount: 0 }, { new: true });
    if (!content) return res.status(404).json(apiResponse.error('Content not found'));
    res.json(apiResponse.success(content, 'Reports dismissed'));
  } catch (err) { next(err); }
};

const getContentReports = async (req, res, next) => {
  try {
    const reports = await ContentReport.find({ contentId: req.params.id })
      .populate('reporterId', 'firstName lastName email')
      .sort({ createdAt: -1 });
    res.json(apiResponse.success(reports));
  } catch (err) { next(err); }
};

module.exports = {
  getPendingApplications, rejectApplication, getUsers, banUser, unbanUser,
  moderateContent, getStats, promoteCreator, getContent, removeContent, dismissReports, getContentReports,
};
