const knowledgeService = require('../services/knowledgeService');
const apiResponse = require('../utils/apiResponse');

const getProfile = async (req, res, next) => {
  try {
    const profile = await knowledgeService.getProfile(req.user.userId);
    res.json(apiResponse.success(profile));
  } catch (err) { next(err); }
};

const getTopicDetail = async (req, res, next) => {
  try {
    const detail = await knowledgeService.getTopicDetail(req.user.userId, req.params.topic);
    res.json(apiResponse.success(detail));
  } catch (err) { next(err); }
};

const getGaps = async (req, res, next) => {
  try {
    const gaps = await knowledgeService.getGaps(req.user.userId);
    res.json(apiResponse.success(gaps));
  } catch (err) { next(err); }
};

const getStrengths = async (req, res, next) => {
  try {
    const strengths = await knowledgeService.getStrengths(req.user.userId);
    res.json(apiResponse.success(strengths));
  } catch (err) { next(err); }
};

module.exports = { getProfile, getTopicDetail, getGaps, getStrengths };
