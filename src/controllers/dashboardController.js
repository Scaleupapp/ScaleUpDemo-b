const dashboardService = require('../services/dashboardService');
const apiResponse = require('../utils/apiResponse');

const getDashboard = async (req, res, next) => {
  try {
    const data = await dashboardService.getDashboard(req.user.userId);
    const response = apiResponse.success(data);
    console.log('📊 DASHBOARD RESPONSE:', JSON.stringify(response, null, 2));
    res.json(response);
  } catch (err) {
    console.error('📊 DASHBOARD ERROR:', err);
    next(err);
  }
};

module.exports = { getDashboard };
