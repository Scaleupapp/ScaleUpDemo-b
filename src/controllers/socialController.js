const socialService = require('../services/socialService');
const moderationService = require('../services/moderationService');
const apiResponse = require('../utils/apiResponse');

// ─── Follow ──────────────────────────────────────────────────────────
const followUser = async (req, res, next) => {
  try { res.status(201).json(apiResponse.success(await socialService.followUser(req.user.userId, req.params.userId))); } catch (err) { next(err); }
};
const unfollowUser = async (req, res, next) => {
  try { res.json(apiResponse.success(await socialService.unfollowUser(req.user.userId, req.params.userId))); } catch (err) { next(err); }
};
const getFollowers = async (req, res, next) => {
  try {
    const data = await socialService.getFollowers(req.params.userId, req.query, req.user.userId);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};
const getFollowing = async (req, res, next) => {
  try {
    const data = await socialService.getFollowing(req.params.userId, req.query, req.user.userId);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

// ─── Comments ────────────────────────────────────────────────────────
const deleteComment = async (req, res, next) => {
  try { res.json(apiResponse.success(await socialService.deleteComment(req.user.userId, req.params.commentId))); } catch (err) { next(err); }
};
const editComment = async (req, res, next) => {
  try { res.json(apiResponse.success(await socialService.editComment(req.user.userId, req.params.commentId, req.body.text))); } catch (err) { next(err); }
};
const toggleCommentLike = async (req, res, next) => {
  try { res.json(apiResponse.success(await socialService.toggleCommentLike(req.user.userId, req.params.commentId))); } catch (err) { next(err); }
};
const getReplies = async (req, res, next) => {
  try { res.json(apiResponse.success(await socialService.getReplies(req.params.commentId, req.query, req.user.userId))); } catch (err) { next(err); }
};

// ─── Playlists ───────────────────────────────────────────────────────
const createPlaylist = async (req, res, next) => {
  try { res.status(201).json(apiResponse.success(await socialService.createPlaylist(req.user.userId, req.body))); } catch (err) { next(err); }
};
const getMyPlaylists = async (req, res, next) => {
  try { res.json(apiResponse.success(await socialService.getMyPlaylists(req.user.userId))); } catch (err) { next(err); }
};
const getPlaylist = async (req, res, next) => {
  try { res.json(apiResponse.success(await socialService.getPlaylist(req.params.playlistId, req.user.userId))); } catch (err) { next(err); }
};
const updatePlaylist = async (req, res, next) => {
  try { res.json(apiResponse.success(await socialService.updatePlaylist(req.user.userId, req.params.playlistId, req.body))); } catch (err) { next(err); }
};
const addToPlaylist = async (req, res, next) => {
  try { res.json(apiResponse.success(await socialService.addToPlaylist(req.user.userId, req.params.playlistId, req.body.contentId))); } catch (err) { next(err); }
};
const removeFromPlaylist = async (req, res, next) => {
  try { res.json(apiResponse.success(await socialService.removeFromPlaylist(req.user.userId, req.params.playlistId, req.params.contentId))); } catch (err) { next(err); }
};
const deletePlaylist = async (req, res, next) => {
  try { res.json(apiResponse.success(await socialService.deletePlaylist(req.user.userId, req.params.playlistId))); } catch (err) { next(err); }
};

// ─── Moderation: block & report ──────────────────────────────────────
const blockUser = async (req, res, next) => {
  try { res.json(apiResponse.success(await moderationService.blockUser(req.user.userId, req.params.userId))); } catch (err) { next(err); }
};
const unblockUser = async (req, res, next) => {
  try { res.json(apiResponse.success(await moderationService.unblockUser(req.user.userId, req.params.userId))); } catch (err) { next(err); }
};
const getBlocked = async (req, res, next) => {
  try { res.json(apiResponse.success(await moderationService.listBlocked(req.user.userId))); } catch (err) { next(err); }
};
const reportTarget = async (req, res, next) => {
  try {
    const { targetType, targetId, reason, description } = req.body || {};
    res.status(201).json(apiResponse.success(
      await moderationService.report({ reporterId: req.user.userId, targetType, targetId, reason, description }),
    ));
  } catch (err) { next(err); }
};

module.exports = {
  followUser, unfollowUser, getFollowers, getFollowing,
  deleteComment, editComment, toggleCommentLike, getReplies,
  createPlaylist, getMyPlaylists, getPlaylist, updatePlaylist, addToPlaylist, removeFromPlaylist, deletePlaylist,
  blockUser, unblockUser, getBlocked, reportTarget,
};
