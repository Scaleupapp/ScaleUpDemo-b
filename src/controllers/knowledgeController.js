const knowledgeService = require('../services/knowledgeService');
const apiResponse = require('../utils/apiResponse');

const getProfile = async (req, res, next) => {
  try {
    const profile = await knowledgeService.getProfile(req.user.userId);
    const { objectiveId } = req.query;

    // If objectiveId is provided, filter topic mastery to that objective (+ legacy null entries)
    if (profile && objectiveId) {
      const profileObj = profile.toObject ? profile.toObject() : { ...profile };
      if (profileObj.topicMastery) {
        profileObj.topicMastery = profileObj.topicMastery.filter(entry =>
          !entry.objectiveId ||
          entry.objectiveId.toString() === objectiveId
        );
        // Recalculate summary fields based on filtered data
        profileObj.totalTopicsCovered = profileObj.topicMastery.length;
        const scores = profileObj.topicMastery.map(t => t.score).filter(s => s > 0);
        profileObj.overallScore = scores.length > 0
          ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
          : 0;
        profileObj.strengths = profileObj.topicMastery
          .filter(t => t.score >= 70)
          .sort((a, b) => b.score - a.score)
          .slice(0, 10)
          .map(t => t.topic);
        profileObj.weaknesses = profileObj.topicMastery
          .filter(t => t.score < 50 && t.quizzesTaken > 0)
          .sort((a, b) => a.score - b.score)
          .slice(0, 10)
          .map(t => t.topic);
      }
      return res.json(apiResponse.success(profileObj));
    }

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
    const { objectiveId } = req.query;

    if (objectiveId && Array.isArray(gaps)) {
      const filtered = gaps.filter(entry =>
        !entry.objectiveId ||
        entry.objectiveId.toString() === objectiveId
      );
      return res.json(apiResponse.success(filtered));
    }

    res.json(apiResponse.success(gaps));
  } catch (err) { next(err); }
};

const getStrengths = async (req, res, next) => {
  try {
    const strengths = await knowledgeService.getStrengths(req.user.userId);
    const { objectiveId } = req.query;

    if (objectiveId && Array.isArray(strengths)) {
      const filtered = strengths.filter(entry =>
        !entry.objectiveId ||
        entry.objectiveId.toString() === objectiveId
      );
      return res.json(apiResponse.success(filtered));
    }

    res.json(apiResponse.success(strengths));
  } catch (err) { next(err); }
};

module.exports = { getProfile, getTopicDetail, getGaps, getStrengths };
