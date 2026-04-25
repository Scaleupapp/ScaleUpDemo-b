const consumptionService = require('../services/consumptionService');
const progressInsightsService = require('../services/progressInsightsService');
const apiResponse = require('../utils/apiResponse');

const updateProgress = async (req, res, next) => {
  try {
    const progress = await consumptionService.updateProgress(req.user.userId, req.params.contentId, req.body);
    res.json(apiResponse.success(progress));
  } catch (err) { next(err); }
};

const markCompleted = async (req, res, next) => {
  try {
    const progress = await consumptionService.markCompleted(req.user.userId, req.params.contentId);
    res.json(apiResponse.success(progress, 'Content marked as completed'));
  } catch (err) { next(err); }
};

const getHistory = async (req, res, next) => {
  try {
    const data = await consumptionService.getHistory(req.user.userId, req.query);
    res.json(apiResponse.paginated(data.items, data.pagination));
  } catch (err) { next(err); }
};

const getStats = async (req, res, next) => {
  try {
    const stats = await consumptionService.getStats(req.user.userId);
    res.json(apiResponse.success(stats));
  } catch (err) { next(err); }
};

const getActivityHeatmap = async (req, res, next) => {
  try {
    const days = parseInt(req.query.days) || 90;
    const data = await consumptionService.getActivityHeatmap(req.user.userId, days);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const getTimeline = async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const data = await consumptionService.getTimeline(req.user.userId, limit);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const getInsights = async (req, res, next) => {
  try {
    const refresh = req.query.refresh === 'true' || req.query.refresh === '1';
    const data = await progressInsightsService.generateForUser(req.user.userId, { refresh });
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

module.exports = { updateProgress, markCompleted, getHistory, getStats, getActivityHeatmap, getTimeline, getInsights };
