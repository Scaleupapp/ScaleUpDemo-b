const User = require('../models/User');
const Content = require('../models/Content');
const Journey = require('../models/Journey');
const Quiz = require('../models/Quiz');
const Follow = require('../models/Follow');
const Notification = require('../models/Notification');
const WeeklyLeaderboard = require('../models/WeeklyLeaderboard');
const apiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');
const { uploadBuffer } = require('../config/s3');
const { v4: uuidv4 } = require('uuid');

const getProfile = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.userId).select('-password -refreshTokenHash');
    if (!user) throw new ApiError(404, 'User not found');
    res.json(apiResponse.success(user));
  } catch (err) { next(err); }
};

const getPublicProfile = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.userId)
      .select('firstName lastName username profilePicture bio role followersCount followingCount skills createdAt isActive');
    if (!user) throw new ApiError(404, 'User not found');
    if (!user.isActive) throw new ApiError(410, 'This account is no longer active');
    res.json(apiResponse.success(user));
  } catch (err) { next(err); }
};

const updateProfile = async (req, res, next) => {
  try {
    const allowed = ['firstName', 'lastName', 'username', 'bio', 'dateOfBirth', 'location',
      'education', 'workExperience', 'skills', 'profilePicture', 'phone', 'deviceType', 'fcmToken'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    const user = await User.findByIdAndUpdate(req.user.userId, updates, { new: true, runValidators: true })
      .select('-password -refreshTokenHash');
    if (!user) throw new ApiError(404, 'User not found');
    res.json(apiResponse.success(user));
  } catch (err) { next(err); }
};

const deleteAccount = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const user = await User.findById(userId);
    if (!user) throw new ApiError(404, 'User not found');

    // 1. Deactivate user
    user.isActive = false;
    user.deletedAt = new Date();
    user.fcmToken = undefined; // Stop push notifications
    user.tokenVersion += 1;    // Invalidate all refresh tokens
    await user.save();

    // 2. Hide creator content (set to 'deactivated' status, preserving original status)
    if (user.role === 'creator' || user.role === 'admin') {
      await Content.updateMany(
        { creatorId: userId, status: { $in: ['published', 'draft'] } },
        { $set: { status: 'deactivated', _preDeactivationStatus: '$status' } }
      );
      // Store original status for restore
      const contents = await Content.find({ creatorId: userId, status: 'deactivated' });
      for (const c of contents) {
        if (!c._preDeactivationStatus || c._preDeactivationStatus === '$status') {
          c._preDeactivationStatus = 'published';
          await c.save();
        }
      }
    }

    // 3. Pause active journeys
    await Journey.updateMany(
      { userId, status: 'active' },
      { $set: { status: 'paused', pausedAt: new Date() } }
    );

    // 4. Cancel pending quizzes
    await Quiz.updateMany(
      { userId, status: { $in: ['ready', 'delivered'] } },
      { $set: { status: 'cancelled' } }
    );

    // 5. Fix follow counts — decrement counters on all related users
    const [following, followers] = await Promise.all([
      Follow.find({ followerId: userId }).select('followingId').lean(),
      Follow.find({ followingId: userId }).select('followerId').lean(),
    ]);
    // Decrement followersCount for everyone this user was following
    if (following.length > 0) {
      await User.updateMany(
        { _id: { $in: following.map(f => f.followingId) } },
        { $inc: { followersCount: -1 } }
      );
    }
    // Decrement followingCount for everyone who was following this user
    if (followers.length > 0) {
      await User.updateMany(
        { _id: { $in: followers.map(f => f.followerId) } },
        { $inc: { followingCount: -1 } }
      );
    }

    // 6. Mark all unread notifications as read
    await Notification.updateMany(
      { userId, isRead: false },
      { $set: { isRead: true } }
    );

    // 7. Remove from active leaderboards
    await WeeklyLeaderboard.updateMany(
      { 'entries.userId': userId },
      { $pull: { entries: { userId } } }
    );

    // 8. Clear auth middleware cache
    const auth = require('../middleware/auth');
    auth.clearCache(userId);

    console.log(`[Deactivation] User ${userId} (${user.email}) deactivated. Content hidden: ${user.role === 'creator'}, Follows adjusted: ${following.length + followers.length}`);

    res.json(apiResponse.success(null, 'Account deactivated'));
  } catch (err) { next(err); }
};

const uploadAvatar = async (req, res, next) => {
  try {
    if (!req.file) throw new ApiError(400, 'No image file provided');

    const ext = req.file.mimetype === 'image/png' ? 'png' : 'jpg';
    const key = `avatars/${req.user.userId}/${uuidv4()}.${ext}`;
    const url = await uploadBuffer(key, req.file.buffer, req.file.mimetype, { publicRead: true });

    const user = await User.findByIdAndUpdate(
      req.user.userId,
      { profilePicture: url },
      { new: true }
    ).select('-password -refreshTokenHash');

    res.json(apiResponse.success(user));
  } catch (err) { next(err); }
};

const getContributorCard = async (req, res, next) => {
  try {
    const userId = req.params.userId || req.params.id;
    const user = await User.findById(userId)
      .select('firstName lastName username profilePicture bio role education workExperience contributorStats')
      .lean();
    if (!user) return res.status(404).json(apiResponse.error('User not found'));

    // Get their published notes
    const notes = await Content.find({
      creatorId: userId,
      contentType: 'notes',
      status: 'published',
    })
      .select('title domain pageCount viewCount likeCount saveCount createdAt')
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    const totalViews = notes.reduce((s, n) => s + (n.viewCount || 0), 0);
    const totalNotes = await Content.countDocuments({
      creatorId: userId,
      contentType: 'notes',
      status: 'published',
    });

    res.json(apiResponse.success({
      user: {
        _id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        username: user.username,
        profilePicture: user.profilePicture,
        bio: user.bio,
        role: user.role,
        education: (user.education || []).slice(0, 2),
        workExperience: (user.workExperience || []).slice(0, 2),
      },
      stats: {
        totalNotes,
        totalViews,
      },
      recentNotes: notes,
    }));
  } catch (err) { next(err); }
};

module.exports = { getProfile, getPublicProfile, updateProfile, deleteAccount, uploadAvatar, getContributorCard };
