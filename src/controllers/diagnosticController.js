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
      return res.status(409).json(apiResponse.error('Cannot start a new diagnostic right now. Either your objective has no mapped competencies yet, or you completed one less than 30 days ago.'));
    }
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const submitSelfRating = async (req, res, next) => {
  try {
    const data = await diagnosticService.submitSelfRating(req.params.attemptId, req.body?.ratings || {});
    res.json(apiResponse.success(data));
  } catch (err) {
    if (err.message && err.message.startsWith('Could not assemble enough questions')) {
      return res.status(503).json(apiResponse.error(err.message));
    }
    next(err);
  }
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

const { processVoiceAnswer } = require('../services/diagnostic/voiceAnswerService');
const uploadService = require('../services/uploadService');

async function uploadVoiceAnswer(req, res) {
  try {
    const { questionText, canonicalCompetency } = req.body;
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'No audio file provided' });
    }
    const upload = await uploadService.uploadAudioBuffer(req.file.buffer);
    const result = await processVoiceAnswer({
      audioBuffer: req.file.buffer,
      questionText,
      canonicalCompetency,
    });
    return res.json({
      audioUrl: upload.url,
      ...result,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

module.exports = {
  _gateOrPass, start, submitSelfRating, nextQuestion, submitAnswer, finish, abandon, synthesis,
  uploadVoiceAnswer,
};
