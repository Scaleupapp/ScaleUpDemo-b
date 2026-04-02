const notesAnalyticsService = require('../services/notesAnalyticsService');
const apiResponse = require('../utils/apiResponse');

const getAnalytics = async (req, res, next) => {
  try {
    const data = await notesAnalyticsService.getContributorAnalytics(req.user.userId);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const getNoteDetail = async (req, res, next) => {
  try {
    const data = await notesAnalyticsService.getNoteAnalytics(req.user.userId, req.params.id);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

module.exports = { getAnalytics, getNoteDetail };
