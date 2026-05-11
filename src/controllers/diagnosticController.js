const diagnosticService = require('../services/diagnosticService');
const featureFlags = require('../config/featureFlags');
const apiResponse = require('../utils/apiResponse');
const DiagnosticAttempt = require('../models/DiagnosticAttempt');
const TopicTaxonomy = require('../models/TopicTaxonomy');
const topicTaxonomyService = require('../services/diagnostic/topicTaxonomyService');
const recalibrationEligibilityService = require('../services/diagnostic/recalibrationEligibilityService');

function _gateOrPass(req, res, next) {
  if (!featureFlags.day1Diagnostic) {
    return res.status(404).json(apiResponse.error('Diagnostic feature is disabled.'));
  }
  next();
}

// Maps service-level blocked reasons to user-facing message + a stable
// machine code clients switch on. `resumeStep` tells the client which
// onboarding step to drop the user into rather than the default step 1
// (so users don't redo profile + background when only the objective or
// topic-ratings step is missing).
//   Step 3 = Objective + specifics    (NO_OBJECTIVE / EMPTY_SPECIFICS)
//   Step 5 = Interests + self-ratings (NO_TOPIC_RATINGS / NO_SIGNAL)
const BLOCKED_REASON_MAP = {
  NO_OBJECTIVE:    { code: 'NEEDS_ONBOARDING',    resumeStep: 3, message: "You haven't set up a learning objective yet. Let's pick one." },
  EMPTY_SPECIFICS: { code: 'NEEDS_ONBOARDING',    resumeStep: 3, message: 'Your objective is missing some details. Take a minute to fill them in.' },
  NO_SIGNAL:       { code: 'NEEDS_RECALIBRATION', resumeStep: 5, message: "We couldn't build a diagnostic for your objective. Please refresh and try again." },
  NO_TOPIC_RATINGS:{ code: 'NEEDS_ONBOARDING',    resumeStep: 5, message: "We couldn't find your topic ratings. Take a minute to set them." },
};

const start = async (req, res, next) => {
  try {
    const data = await diagnosticService.startAttempt(req.user.userId);
    if (data && data.blocked) {
      const mapped = BLOCKED_REASON_MAP[data.reason] || BLOCKED_REASON_MAP.NO_TOPIC_RATINGS;
      return res.status(409).json({
        success: false,
        error: mapped.message,
        code: mapped.code,
        reason: data.reason,
        resumeStep: mapped.resumeStep,
      });
    }
    if (!data) {
      return res.status(409).json(apiResponse.error('Cannot start a new diagnostic right now.'));
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
    if (!attempt) return res.status(404).json(apiResponse.error('attempt_not_found'));
    // The auth middleware exposes the authenticated user as `req.user.userId`,
    // not `req.user.id`. Comparing against `.id` (which is undefined) used to
    // 403 every poll, leaving iOS stuck on the "Generating insights" screen.
    if (String(attempt.userId) !== String(req.user.userId)) {
      return res.status(403).json(apiResponse.error('forbidden'));
    }

    // Resolve display names from TopicTaxonomy (canonical → display).
    // Mirrors finishAttempt's lookup — falls back silently to canonical names.
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

    // Title-case fallback so the UI never shows raw kebab-case when the
    // TopicTaxonomy lookup misses (it does for many objective/targetKey combos).
    const titleCaseFromSlug = (slug) => String(slug || '')
      .replace(/[-_]+/g, ' ')
      .trim()
      .split(' ')
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
      .join(' ');

    const results = [];
    for (const [comp, v] of attempt.results.entries()) {
      const displayName = displayByCanonical.get(comp) || titleCaseFromSlug(comp);
      results.push({
        competency:          displayName,
        displayName,
        canonicalCompetency: comp,
        band:                v.assessedBand,
        score:               v.score,
        calibrationDelta:    v.calibrationDelta,
        calibrationClass:    v.calibrationClass || 'well-calibrated',
        questionsAsked:      v.questionsAsked,
        selfRating:          v.selfRating || null,
      });
    }

    const planStatus = attempt.appliedToProfileAt ? 'queued' : 'pending';

    const responseBody = {
      attemptId:      String(attempt._id),
      status:         attempt.status,
      insightsStatus: attempt.insightsStatus || 'pending',
      insights:       attempt.insightsJson || null,
      planStatus,
      results,
    };

    if (attempt.attemptType === 'recalibration') {
      responseBody.recalibrationGrowth = attempt.recalibrationGrowth || null;
      responseBody.previousAttemptId = attempt.previousAttemptId;
    }

    // Wrap in the standard {success, data} envelope — iOS APIClient
    // strict-decodes that shape and otherwise treats the response as
    // un-decodable, keeping the user stuck on the polling screen.
    return res.status(200).json(apiResponse.success(responseBody));
  } catch (err) {
    console.error('[diagnosticController.getResults]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}

const getRecalibrationEligibility = async (req, res) => {
  try {
    const out = await recalibrationEligibilityService.computeEligibility(req.user.userId, {
      userFlaggedTopics: req.query.flagged ? String(req.query.flagged).split(',') : [],
    });
    res.status(200).json(out);
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
};

const startRecalibration = async (req, res) => {
  try {
    const out = await diagnosticService.startRecalibration(req.user.userId, {
      userFlaggedTopics: req.body?.flaggedTopics || [],
    });
    res.status(200).json(out);
  } catch (err) {
    if (err.code === 'NOT_ELIGIBLE') return res.status(409).json({ message: err.message, meta: err.meta });
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
};

module.exports = {
  _gateOrPass, start, submitSelfRating, nextQuestion, submitAnswer, finish, abandon, synthesis,
  uploadVoiceAnswer, getResults, getRecalibrationEligibility, startRecalibration,
};
