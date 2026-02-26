const consumptionService = require('../services/consumptionService');
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

module.exports = { updateProgress, markCompleted, getHistory, getStats };
