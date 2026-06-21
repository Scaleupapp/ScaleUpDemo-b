const onboardingService = require('../services/onboardingService');
const apiResponse = require('../utils/apiResponse');
const TopicTaxonomy = require('../models/TopicTaxonomy');
const UserObjective = require('../models/UserObjective');
const User = require('../models/User');
const { normalizeSpecifics } = require('../services/diagnostic/specificsNormalizationService');

const REQUIRED_FIELDS = ['objectiveType', 'timeline', 'currentLevel', 'weeklyCommitHours', 'topicsOfInterest', 'topicSelfRatings'];

const getOnboardingStatus = async (req, res, next) => {
  try { res.json(apiResponse.success(await onboardingService.getOnboardingStatus(req.user.userId))); } catch (err) { next(err); }
};
const updateProfile = async (req, res, next) => {
  try { res.json(apiResponse.success(await onboardingService.updateProfile(req.user.userId, req.body))); } catch (err) { next(err); }
};
const updateBackground = async (req, res, next) => {
  try { res.json(apiResponse.success(await onboardingService.updateBackground(req.user.userId, req.body))); } catch (err) { next(err); }
};
const setObjective = async (req, res, next) => {
  try { res.status(201).json(apiResponse.success(await onboardingService.setObjective(req.user.userId, req.body))); } catch (err) { next(err); }
};
const updatePreferences = async (req, res, next) => {
  try { res.json(apiResponse.success(await onboardingService.updatePreferences(req.user.userId, req.body))); } catch (err) { next(err); }
};
const updateInterests = async (req, res, next) => {
  try { res.json(apiResponse.success(await onboardingService.updateInterests(req.user.userId, req.body))); } catch (err) { next(err); }
};
const completeOnboarding = async function completeOnboarding(req, res) {
  // Auth middleware exposes the authenticated user as `req.user.userId`,
  // not `req.user._id`. Reading `_id` (which is undefined) used to 401 every
  // onboarding completion, leaving users stuck on "Start Learning". Same
  // pattern as the diagnosticController.getResults fix from Phase 1.
  const userId = req.user && (req.user.userId || req.user._id);
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  const body = req.body || {};
  const missing = REQUIRED_FIELDS.filter((f) => body[f] === undefined || body[f] === null);
  if (missing.length) {
    return res.status(400).json({ error: 'missing fields', fields: missing });
  }

  // Best-effort normalization. Service has its own internal fallback, but we still
  // wrap in try/catch as belt-and-braces: nothing should block onboarding completion.
  let specificsCanonical = {};
  try {
    specificsCanonical = await normalizeSpecifics({
      objectiveType: body.objectiveType,
      specifics: body.specifics || {},
    });
  } catch (err) {
    console.warn('[onboarding.complete] normalization threw, continuing without canonical specifics:', err.message);
    specificsCanonical = body.specifics || {};
  }

  // iOS sends topicsOfInterest as objects [{canonicalName, name, source, isFutureProofing}],
  // but the schema expects [String]. Normalize to canonicalName strings. We accept both
  // shapes so older clients sending plain strings still work.
  const topicsOfInterestNormalized = Array.isArray(body.topicsOfInterest)
    ? body.topicsOfInterest
        .map((t) => (typeof t === 'string' ? t : (t && (t.canonicalName || t.name))))
        .filter(Boolean)
    : [];

  const $set = {
    userId,
    objectiveType: body.objectiveType,
    timeline: body.timeline,
    currentLevel: body.currentLevel,
    weeklyCommitHours: body.weeklyCommitHours,
    topicsOfInterest: topicsOfInterestNormalized,
    topicSelfRatings: body.topicSelfRatings,
    specifics: body.specifics || {},
    specificsCanonical,
    needsCalibration: false, // freshly onboarded user has self-ratings
    isPrimary: true,
    status: 'active',
  };
  if (body.preferredLearningStyle) $set.preferredLearningStyle = body.preferredLearningStyle;
  if (body.targetDate) $set.targetDate = body.targetDate;

  let saved;
  try {
    saved = await UserObjective.findOneAndUpdate(
      { userId, isPrimary: true },
      { $set },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    // Surface the failure as JSON so the client doesn't hang waiting on a
    // request the server has already given up on. Previously a CastError
    // crashed the handler and the iOS spinner spun forever.
    console.error('[onboarding.complete] save failed:', err.message, { userId, fields: Object.keys($set) });
    return res.status(500).json({ error: 'save_failed', message: err.message });
  }

  // Mark User as onboarded so the app advances past the onboarding flow.
  // Best-effort: don't fail the response if this somehow errors.
  // v2NeedsOnboarding is cleared here too — once the objective is saved the
  // user has finished the v2 onboarding flow; the diagnostic + reality check
  // + plan are tracked separately, so a relaunch routes them forward, not
  // back into onboarding.
  try {
    await User.findByIdAndUpdate(userId, {
      onboardingComplete: true,
      onboardingStep: 5,
      v2NeedsOnboarding: false,
    });
  } catch (err) {
    console.warn('[onboarding.complete] failed to flip User flags:', err.message);
  }

  // iOS `OnboardingCompleteResponse` requires `needsCalibration`. Don't omit it
  // or JSONDecoder throws and the user sees a silent failure.
  return res.status(200).json({
    userObjectiveId: saved._id,
    needsCalibration: saved.needsCalibration === true,
  });
};

// Build a deterministic taxonomy lookup key.
// Mirrors Plan 1's targetKey convention: '<objectiveType>::<slug>'.
function buildTargetKey(objectiveType, specifics, targetCompany) {
  const slugify = (s) => String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  const parts = [];
  if (specifics) {
    if (specifics.examName) parts.push(slugify(specifics.examName));
    else if (specifics.targetSkill) parts.push(slugify(specifics.targetSkill));
    else if (specifics.targetRole) parts.push(slugify(specifics.targetRole));
    else if (specifics.toDomain) parts.push(slugify(specifics.toDomain));
  }
  if (targetCompany) parts.push(slugify(targetCompany));
  const tail = parts.filter(Boolean).join('-') || 'general';
  return `${objectiveType}::${tail}`;
}

const suggestTopics = async function suggestTopics(req, res) {
  const { objectiveType, specifics = {}, targetCompany } = req.body || {};
  if (!objectiveType) {
    return res.status(400).json({ error: 'objectiveType required' });
  }
  const targetKey = buildTargetKey(objectiveType, specifics, targetCompany);
  let entry = await TopicTaxonomy.findOne({ objectiveType, targetKey });
  let cacheHit = true;

  if (!entry) {
    // Fallback: generate the taxonomy on-demand via LLM. Plan 3a's promised
    // generation, finally wired in. generateTaxonomyForTargetKey is
    // idempotent (it also checks for an existing entry) so concurrent
    // onboarders with the same targetKey are safe.
    cacheHit = false;
    try {
      const { generateTaxonomyForTargetKey } = require('../services/diagnostic/topicTaxonomyService');
      entry = await generateTaxonomyForTargetKey(targetKey);
    } catch (err) {
      console.warn('[onboarding.suggestTopics] LLM generation failed for', targetKey, ':', err.message);
      entry = null;
    }
    if (!entry) {
      return res.status(404).json({
        code: 'TAXONOMY_MISSING',
        message: 'No topic taxonomy found for this objective. Please try a different selection.',
        targetKey,
      });
    }
  }

  return res.status(200).json({
    targetKey,
    source: entry.source,
    cacheHit,
    topics: entry.topics,
  });
};

module.exports = {
  getOnboardingStatus,
  updateProfile,
  updateBackground,
  setObjective,
  updatePreferences,
  updateInterests,
  completeOnboarding,
  suggestTopics,
  _buildTargetKey: buildTargetKey,
};
