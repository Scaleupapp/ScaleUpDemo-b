const diagnosticService = require('../services/diagnosticService');
const featureFlags = require('../config/featureFlags');
const apiResponse = require('../utils/apiResponse');
const DiagnosticAttempt = require('../models/DiagnosticAttempt');
const TopicTaxonomy = require('../models/TopicTaxonomy');
const topicTaxonomyService = require('../services/diagnostic/topicTaxonomyService');

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

async function getResults(req, res) {
  try {
    const attempt = await DiagnosticAttempt.findById(req.params.attemptId);
    if (!attempt) return res.status(404).json({ error: 'attempt_not_found' });
    if (String(attempt.userId) !== String(req.user.id)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    // Resolve display names from TopicTaxonomy (canonical → display).
    // Mirrors finishAttemptV2's lookup — falls back silently to canonical names.
    let displayByCanonical = new Map();
    try {
      const { buildTargetKey } = topicTaxonomyService;
      const objectiveType = attempt.objectiveSnapshot?.objectiveType;
      const targetKey = attempt.objectiveSnapshot?.targetKey
        || (objectiveType
          ? buildTargetKey(objectiveType, attempt.objectiveSnapshot?.specificsCanonical || attempt.objectiveSnapshot?.specifics || {})
          : null);
      if (objectiveType && targetKey) {
        const tax = await TopicTaxonomy.findOne({ objectiveType, targetKey }).lean();
        for (const t of (tax?.topics || [])) {
          displayByCanonical.set(t.canonicalName, t.name);
        }
      }
    } catch (_) { /* fall back to canonical names */ }

    const results = [];
    for (const [comp, v] of attempt.results.entries()) {
      results.push({
        competency:          displayByCanonical.get(comp) || comp,
        canonicalCompetency: comp,
        band:                v.assessedBand,
        score:               v.score,
        calibrationDelta:    v.calibrationDelta,
        calibrationClass:    v.calibrationClass || 'well-calibrated',
        questionsAsked:      v.questionsAsked,
      });
    }

    const planStatus = attempt.appliedToProfileAt ? 'queued' : 'pending';

    return res.status(200).json({
      attemptId:      String(attempt._id),
      status:         attempt.status,
      insightsStatus: attempt.insightsStatus || 'pending',
      insights:       attempt.insightsJson || null,
      planStatus,
      results,
    });
  } catch (err) {
    console.error('[diagnosticController.getResults]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}

module.exports = {
  _gateOrPass, start, submitSelfRating, nextQuestion, submitAnswer, finish, abandon, synthesis,
  uploadVoiceAnswer, getResults,
};
