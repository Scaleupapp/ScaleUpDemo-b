const recommendationService = require('../services/recommendationService');
const apiResponse = require('../utils/apiResponse');

const getPersonalizedFeed = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const data = await recommendationService.getPersonalizedFeed(req.user.userId, { page, limit });
    res.json(apiResponse.paginated(data.items, data.pagination));
  } catch (err) { next(err); }
};

const getSimilarContent = async (req, res, next) => {
  try {
    const data = await recommendationService.getSimilarContent(req.params.id, req.query);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const getObjectiveRecommendations = async (req, res, next) => {
  try {
    const data = await recommendationService.getObjectiveRecommendations(req.user.userId, req.params.objectiveId, req.query);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const getGapFilling = async (req, res, next) => {
  try {
    const data = await recommendationService.getGapFillingRecommendations(req.user.userId, req.query);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const getTrending = async (req, res, next) => {
  try {
    const data = await recommendationService.getTrendingInTopics(req.user.userId, req.query);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

/**
 * "What to do next" — intelligent endpoint returning the best next action
 * based on journey state, pending quizzes, knowledge gaps, and personalized content.
 */
const getNextActions = async (req, res, next) => {
  try {
    const data = await recommendationService.getNextActions(req.user.userId);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

/**
 * Post-quiz recommendations — content suggestions for weak areas from a quiz.
 */
const getPostQuizRecommendations = async (req, res, next) => {
  try {
    const { weakTopics, quizTopic } = req.query;
    const topics = weakTopics ? weakTopics.split(',') : [];
    if (quizTopic && !topics.includes(quizTopic)) topics.push(quizTopic);
    const data = await recommendationService.getPostQuizRecommendations(req.user.userId, topics);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

module.exports = {
  getPersonalizedFeed, getSimilarContent, getObjectiveRecommendations,
  getGapFilling, getTrending, getNextActions, getPostQuizRecommendations,
};
