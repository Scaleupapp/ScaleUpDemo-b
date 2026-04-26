const userInferenceService = require('../services/userInferenceService');
const apiResponse = require('../utils/apiResponse');

const list = async (req, res, next) => {
  try {
    const includeResolved = req.query.includeResolved === 'true' || req.query.includeResolved === '1';
    const data = await userInferenceService.listForUser(req.user.userId, { includeResolved });
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const resolve = async (req, res, next) => {
  try {
    const { key } = req.params;
    const { status } = req.body || {};
    const result = await userInferenceService.resolve(req.user.userId, key, status);
    if (!result) return res.status(404).json(apiResponse.error('Inference not found'));
    res.json(apiResponse.success(result));
  } catch (err) { next(err); }
};

module.exports = { list, resolve };
