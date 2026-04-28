const diagnosticService = require('../services/diagnosticService');
const featureFlags = require('../config/featureFlags');
const apiResponse = require('../utils/apiResponse');

function _gateOrPass(req, res, next) {
  if (!featureFlags.day1Diagnostic) {
    return res.status(404).json(apiResponse.error('Diagnostic feature is disabled.'));
  }
  next();
}

const start = async (req, res, next) => {
  try {
    const data = await diagnosticService.startAttempt(req.user.userId);
    if (!data) {
      return res.status(409).json(apiResponse.error('Objective has no mapped competencies yet — try again in a minute.'));
    }
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const submitSelfRating = async (req, res, next) => {
  try {
    const data = await diagnosticService.submitSelfRating(req.params.attemptId, req.body?.ratings || {});
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const nextQuestion = async (req, res, next) => {
  try {
    const data = await diagnosticService.nextQuestion(req.params.attemptId);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const submitAnswer = async (req, res, next) => {
  try {
    const { questionId, selectedAnswer, timeTaken } = req.body || {};
    const data = await diagnosticService.submitAnswer(
      req.params.attemptId, questionId, selectedAnswer, timeTaken,
    );
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const finish = async (req, res, next) => {
  try {
    const data = await diagnosticService.finishAttempt(req.params.attemptId);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const abandon = async (req, res, next) => {
  try {
    const data = await diagnosticService.abandon(req.params.attemptId);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const synthesis = async (req, res, next) => {
  try {
    const data = await diagnosticService.getSynthesis(req.user.userId);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

module.exports = {
  _gateOrPass, start, submitSelfRating, nextQuestion, submitAnswer, finish, abandon, synthesis,
};
