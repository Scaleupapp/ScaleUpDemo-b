const socialService = require('../services/socialService');
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
    const data = await socialService.getFollowers(req.params.userId, req.query);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};
const getFollowing = async (req, res, next) => {
  try {
    const data = await socialService.getFollowing(req.params.userId, req.query);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

// ─── Comments ────────────────────────────────────────────────────────
const deleteComment = async (req, res, next) => {
  try { res.json(apiResponse.success(await socialService.deleteComment(req.user.userId, req.params.commentId))); } catch (err) { next(err); }
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

module.exports = {
  followUser, unfollowUser, getFollowers, getFollowing,
  deleteComment,
  createPlaylist, getMyPlaylists, getPlaylist, updatePlaylist, addToPlaylist, removeFromPlaylist, deletePlaylist,
};
