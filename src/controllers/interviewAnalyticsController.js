const interviewAnalyticsService = require('../services/interviewAnalyticsService');
const apiResponse = require('../utils/apiResponse');

const getAnalytics = async (req, res, next) => {
  try {
    const data = await interviewAnalyticsService.getAnalytics(req.user.userId);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

module.exports = {
  getAnalytics,
};
