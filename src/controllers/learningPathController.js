const learningPathService = require('../services/learningPathService');
const apiResponse = require('../utils/apiResponse');

const createPath = async (req, res, next) => {
  try { res.status(201).json(apiResponse.success(await learningPathService.createPath(req.user.userId, req.body))); } catch (err) { next(err); }
};
const updatePath = async (req, res, next) => {
  try { res.json(apiResponse.success(await learningPathService.updatePath(req.user.userId, req.params.id, req.body))); } catch (err) { next(err); }
};
const addItem = async (req, res, next) => {
  try { res.json(apiResponse.success(await learningPathService.addItem(req.user.userId, req.params.id, req.body))); } catch (err) { next(err); }
};
const removeItem = async (req, res, next) => {
  try { res.json(apiResponse.success(await learningPathService.removeItem(req.user.userId, req.params.id, req.params.contentId))); } catch (err) { next(err); }
};
const reorderItems = async (req, res, next) => {
  try { res.json(apiResponse.success(await learningPathService.reorderItems(req.user.userId, req.params.id, req.body.orderedContentIds))); } catch (err) { next(err); }
};
const publishPath = async (req, res, next) => {
  try { res.json(apiResponse.success(await learningPathService.publishPath(req.user.userId, req.params.id), 'Learning path published')); } catch (err) { next(err); }
};
const archivePath = async (req, res, next) => {
  try { res.json(apiResponse.success(await learningPathService.archivePath(req.user.userId, req.params.id))); } catch (err) { next(err); }
};
const getMyPaths = async (req, res, next) => {
  try {
    const data = await learningPathService.getMyPaths(req.user.userId, req.query);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};
const getPath = async (req, res, next) => {
  try { res.json(apiResponse.success(await learningPathService.getPath(req.params.id))); } catch (err) { next(err); }
};
const explorePaths = async (req, res, next) => {
  try {
    const data = await learningPathService.explorePaths(req.query);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};
const followPath = async (req, res, next) => {
  try { res.json(apiResponse.success(await learningPathService.followPath(req.user.userId, req.params.id))); } catch (err) { next(err); }
};
const unfollowPath = async (req, res, next) => {
  try { res.json(apiResponse.success(await learningPathService.unfollowPath(req.user.userId, req.params.id))); } catch (err) { next(err); }
};
const ratePath = async (req, res, next) => {
  try { res.json(apiResponse.success(await learningPathService.ratePath(req.user.userId, req.params.id, req.body.rating))); } catch (err) { next(err); }
};

module.exports = {
  createPath, updatePath, addItem, removeItem, reorderItems,
  publishPath, archivePath, getMyPaths, getPath, explorePaths,
  followPath, unfollowPath, ratePath,
};
