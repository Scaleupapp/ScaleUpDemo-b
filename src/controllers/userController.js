const User = require('../models/User');
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
      .select('firstName lastName username profilePicture bio role followersCount followingCount skills createdAt');
    if (!user) throw new ApiError(404, 'User not found');
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
    const user = await User.findById(req.user.userId);
    if (!user) throw new ApiError(404, 'User not found');
    user.isActive = false;
    user.deletedAt = new Date();
    await user.save();
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

module.exports = { getProfile, getPublicProfile, updateProfile, deleteAccount, uploadAvatar };
