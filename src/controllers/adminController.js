const creatorService = require('../services/creatorService');
const User = require('../models/User');
const Content = require('../models/Content');
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
        { email: { $regex: req.query.search, $options: 'i' } },
      ];
    }
    const users = await User.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit);
    const total = await User.countDocuments(filter);
    res.json(apiResponse.paginated(users, { total, page, limit, totalPages: Math.ceil(total / limit) }));
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
    const [totalUsers, totalCreators, totalContent, publishedContent] = await Promise.all([
      User.countDocuments({ isActive: true }),
      User.countDocuments({ role: 'creator' }),
      Content.countDocuments(),
      Content.countDocuments({ status: 'published' }),
    ]);
    res.json(apiResponse.success({ totalUsers, totalCreators, totalContent, publishedContent }));
  } catch (err) { next(err); }
};

module.exports = { getPendingApplications, rejectApplication, getUsers, banUser, unbanUser, moderateContent, getStats };
