/**
 * Diagnostic Service — orchestrates a single diagnostic attempt across its lifecycle.
 *
 * Public API:
 *   startAttempt(userId)              → { attemptId, flowType, competenciesToAssess, ... }
 *   submitSelfRating(attemptId, ...)  → kicks off pool generation, returns when ready
 *   nextQuestion(attemptId)           → { question } or { done: true }
 *   submitAnswer(attemptId, ...)      → { ack: true }
 *   finishAttempt(attemptId)          → results + insights
 *   abandon(attemptId)                → handles 3-tier abandonment policy
 *   startRecalibration(userId, opts)  → seeds a recalibration attempt
 *   getSynthesis(userId)              → E1 synthesis screen payload
 */

const telemetry = require('./diagnosticTelemetryService');
const { planGenerationQueue } = require('../config/queue');
const userContextService = require('./userContextService');
const DiagnosticAttempt = require('../models/DiagnosticAttempt');
const UserObjective = require('../models/UserObjective');
const diagnosticPoolService = require('./diagnosticPoolService');
const DiagnosticQuestionBank = require('../models/DiagnosticQuestionBank');
const calibration = require('../utils/calibration');
// recalibrationEligibilityService is lazy-required inside startRecalibration
// so tests can stub it via require.cache without a module re-load.

const ACTIVE_ATTEMPT_STATUSES = ['in_progress'];

async function submitSelfRating(attemptId, ratings) {
  const attempt = await DiagnosticAttempt.findById(attemptId);
  if (!attempt) throw new Error('attempt not found');

  // Persist ratings
  for (const [comp, rating] of Object.entries(ratings || {})) {
    attempt.selfRatings.set(comp, rating);
  }

  // Calculate allocation + assemble pool
  const competencies = Array.from(attempt.selfRatings.entries())
    .map(([name, selfRating]) => ({ name, selfRating }));
  const allocation = diagnosticPoolService._internal.calculatePoolAllocation(competencies);
  const pool = await diagnosticPoolService.assemblePool(allocation, {
    objective: attempt.objectiveSnapshot?.label || null,
  });
  attempt.poolQuestionIds = pool.map(q => q._id).filter(Boolean);
  await attempt.save();
  telemetry.logEvent('diagnostic.self_rating_submitted', { attemptId: String(attemptId) });
  return { ready: true, poolSize: pool.length };
}

/**
 * Build the E1 synthesis screen payload for an existing user. Reformats
 * userContextService output into a UI-friendly shape with stable keys.
 * Also includes key fields from the most recent completed DiagnosticAttempt.
 */
async function getSynthesis(userId) {
  const [ctx, lastAttempt] = await Promise.all([
    userContextService.getUserContext(userId),
    DiagnosticAttempt.findOne(
      { userId, status: 'completed' },
      null,
      { sort: { completedAt: -1 } },
    ),
  ]);

  // Derive strongest/weakest from the last attempt's results if available
  let diagnosticStrongest = [];
  let diagnosticWeakest = [];
  if (lastAttempt?.results) {
    const entries = Array.from(lastAttempt.results.entries())
      .map(([comp, r]) => ({ competency: comp, score: r.score || 0, band: r.assessedBand }));
    entries.sort((a, b) => b.score - a.score);
    diagnosticStrongest = entries.slice(0, 3);
    diagnosticWeakest = entries.slice(-3).reverse();
  }

  return {
    weakest:           ctx.weakTopics?.slice(0, 3) || [],
    strongest:         ctx.strongTopics?.slice(0, 2) || [],
    recurringConfusion: ctx.misconceptions?.[0] || null,
    cognitive:         ctx.cognitiveTraits?.[0] || null,
    objective:         ctx.objective || null,
    activitySummary: {
      totalQuizzesTaken:   ctx.profile?.totalQuizzesTaken ?? 0,
      totalTopicsCovered:  ctx.profile?.totalTopicsCovered ?? 0,
    },
    lastDiagnostic: lastAttempt
      ? {
          completedAt:      lastAttempt.completedAt,
          strongestTopics:  diagnosticStrongest,
          weakestTopics:    diagnosticWeakest,
        }
      : null,
  };
}

async function abandon(attemptId) {
  const attempt = await DiagnosticAttempt.findById(attemptId);
  if (!attempt) throw new Error('attempt not found');
  if (attempt.status === 'completed' || attempt.status === 'abandoned') return { status: attempt.status };

  const total = attempt.poolQuestionIds.length || 1;
  const answered = attempt.answers.length;
  const pct = answered / total;

  if (pct >= 0.7) {
    // High completion — process as if finished
    return finishAttempt(attemptId);
  }
  if (pct >= 0.3) {
    // Mid-completion — caller (via UI) chooses; here we mark abandoned with
    // partial_processed strategy and call finishAttempt to lock in what we have.
    attempt.abandonStrategy = 'partial_processed';
    attempt.abandonedAt = new Date();
    await attempt.save();
    return finishAttempt(attemptId);
  }
  // <30% — drop
  attempt.status = 'abandoned';
  attempt.abandonStrategy = 'dropped';
  attempt.abandonedAt = new Date();
  await attempt.save();
  telemetry.logEvent('diagnostic.abandoned', { userId: String(attempt.userId), strategy: 'dropped', pct: Math.round(pct * 100) });
  return { status: 'abandoned', abandonStrategy: 'dropped' };
}

// ---------------------------------------------------------------------------
// Diagnostic engine — taxonomy-driven, canonical-name-throughout.
// ---------------------------------------------------------------------------

function _getTaxonomyHelpers() {
  return require('./diagnostic/topicTaxonomyService');
}
function _getSelectorPlan() {
  return require('./diagnosticSelectorService');
}
function _getTopicTaxonomyModel() {
  return require('../models/TopicTaxonomy');
}

// In-memory cache of pool snapshots keyed by attemptId. The DiagnosticAttempt
// schema only stores `poolQuestionIds` (refs); the engine needs the *full*
// question docs (with canonicalCompetency, correctAnswer) on every
// nextQuestion / submitAnswer call. Keeping a snapshot in-memory avoids
// refactoring the schema. Production uses sticky sessions; if that changes,
// rehydrate from DiagnosticQuestionBank by id.
const _attemptPoolCache = new Map(); // attemptId(string) -> [questionDoc, ...]

function _snapshotKey(attempt) {
  return String(attempt._id);
}

// Self-healing helper: try to backfill an objective's topicSelfRatings using
// the same 4-tier fallback as scripts/migrate/backfillTopicSelfRatings.js.
// Returns { ratings: Map, source, canonicalToPersist? } on success, or
// { ratings: null, reason } when no signal is available.
async function _selfHealTopicSelfRatings(objective) {
  const { buildTargetKey } = _getTaxonomyHelpers();
  const TopicTaxonomy = _getTopicTaxonomyModel();
  const DEFAULT_RATING = 'familiar';

  const ratingsFromTopics = (topics) => {
    const r = new Map();
    for (const t of topics || []) {
      if (t && t.canonicalName) r.set(t.canonicalName, DEFAULT_RATING);
    }
    return r;
  };

  // 1) Existing taxonomy lookup with current canonical/specifics.
  try {
    const targetKey = buildTargetKey(
      objective.objectiveType,
      objective.specificsCanonical || objective.specifics || {},
    );
    const tax = await TopicTaxonomy.findOne({ objectiveType: objective.objectiveType, targetKey }).lean();
    if (tax && tax.topics?.length > 0) {
      return { ratings: ratingsFromTopics(tax.topics), source: 'taxonomy' };
    }
  } catch (_) { /* fall through */ }

  // 2) If specifics has values but specificsCanonical is empty, normalize
  //    via LLM and retry the lookup, then fall through to LLM generation.
  const specificsHasValue = (s) => s && Object.values(s).some(v => v != null && v !== '');
  let canonicalToPersist = null;
  if (specificsHasValue(objective.specifics) && !specificsHasValue(objective.specificsCanonical)) {
    try {
      const { normalizeSpecifics } = require('./diagnostic/specificsNormalizationService');
      const normalized = await normalizeSpecifics({
        objectiveType: objective.objectiveType,
        specifics: objective.specifics,
      });
      if (specificsHasValue(normalized)) {
        canonicalToPersist = normalized;
        const targetKey2 = buildTargetKey(objective.objectiveType, normalized);
        const tax2 = await TopicTaxonomy.findOne({ objectiveType: objective.objectiveType, targetKey: targetKey2 }).lean();
        if (tax2 && tax2.topics?.length > 0) {
          return { ratings: ratingsFromTopics(tax2.topics), source: 'taxonomy-after-normalize', canonicalToPersist };
        }
        // 3) Generate a taxonomy via LLM as last resort.
        try {
          const { generateTaxonomyForTargetKey } = require('./diagnostic/topicTaxonomyService');
          const tax3 = await generateTaxonomyForTargetKey(targetKey2);
          if (tax3 && tax3.topics?.length > 0) {
            return { ratings: ratingsFromTopics(tax3.topics), source: 'taxonomy-generated', canonicalToPersist };
          }
        } catch (_) { /* fall through */ }
      }
    } catch (_) { /* fall through */ }
  }

  // 4) V1 onboarding shape — fall back to analysis.competencies.
  const competencies = objective.analysis?.competencies || [];
  if (competencies.length > 0) {
    const r = new Map();
    for (const c of competencies) {
      if (c?.name) r.set(c.name, DEFAULT_RATING);
    }
    if (r.size > 0) return { ratings: r, source: 'competencies' };
  }

  return {
    ratings: null,
    reason: specificsHasValue(objective.specifics) ? 'NO_SIGNAL' : 'EMPTY_SPECIFICS',
  };
}

async function startAttempt(userId) {
  const { canonicalize, buildTargetKey } = _getTaxonomyHelpers();
  const { totalQuestionsForAttempt } = _getSelectorPlan();

  const objective = await UserObjective.findOne({ userId, status: 'active', isPrimary: true }).lean()
    || await UserObjective.findOne({ userId, status: 'active' }).lean();
  if (!objective) return { blocked: true, reason: 'NO_OBJECTIVE' };

  // Canonicalize topicSelfRatings keys (display names → canonical).
  const ratingsRaw = objective.topicSelfRatings || new Map();
  const ratingsIter = ratingsRaw instanceof Map
    ? Array.from(ratingsRaw.entries())
    : Object.entries(ratingsRaw);
  let canonicalRatings = new Map();
  for (const [name, rating] of ratingsIter) {
    if (!rating) continue;
    canonicalRatings.set(canonicalize(name), rating);
  }

  // Self-healing: if topicSelfRatings is empty, run the migration's fallback
  // chain inline. Persists the seeded ratings so future calls see them.
  if (canonicalRatings.size === 0) {
    const seeded = await _selfHealTopicSelfRatings(objective);
    if (seeded.ratings && seeded.ratings.size > 0) {
      canonicalRatings = seeded.ratings;
      try {
        const update = { topicSelfRatings: Object.fromEntries(canonicalRatings.entries()) };
        if (seeded.canonicalToPersist) update.specificsCanonical = seeded.canonicalToPersist;
        await UserObjective.updateOne({ _id: objective._id }, { $set: update });
        objective.topicSelfRatings = update.topicSelfRatings;
        if (seeded.canonicalToPersist) objective.specificsCanonical = seeded.canonicalToPersist;
        telemetry.logEvent('diagnostic.self_healed', {
          userId: String(userId),
          source: seeded.source,
          ratingsCount: canonicalRatings.size,
        });
      } catch (err) {
        console.warn('[diagnosticService] self-heal persist failed:', err.message);
      }
    } else {
      // Still empty — surface a structured reason for client routing.
      return { blocked: true, reason: seeded.reason || 'NO_TOPIC_RATINGS' };
    }
  }

  const targetKey = buildTargetKey(
    objective.objectiveType,
    objective.specificsCanonical || objective.specifics || {},
  );

  // Abandon any prior in-progress attempts to keep one_active_attempt_per_user clean.
  await DiagnosticAttempt.updateMany(
    { userId, status: { $in: ACTIVE_ATTEMPT_STATUSES } },
    { $set: { status: 'abandoned', abandonedAt: new Date() } },
  );

  const totalEstimated = totalQuestionsForAttempt(canonicalRatings);

  const objectiveLabel = objective.specifics?.examName
    || objective.specifics?.targetSkill
    || objective.specifics?.targetRole
    || objective.objectiveType
    || null;

  const attempt = new DiagnosticAttempt({
    userId,
    flowType: 'new_user',
    status: 'in_progress',
    startedAt: new Date(),
    selfRatings: canonicalRatings, // canonical keys throughout
    objectiveSnapshot: {
      _id: objective._id,
      label: objectiveLabel,
    },
    attemptType: 'initial',
    planGenerationStatus: 'pending',
  });
  await attempt.save();

  // Stash targetKey + objectiveType on the in-memory snapshot meta so
  // subsequent calls don't have to re-derive (and so this works even if the
  // schema doesn't have a targetKey field).
  _attemptPoolCache.set(_snapshotKey(attempt), { _meta: { targetKey, objectiveType: objective.objectiveType } });

  telemetry.logEvent('diagnostic.started', { userId: String(userId), flowType: 'new_user' });

  return {
    attemptId: attempt._id,
    flowType: 'new_user',
    totalEstimatedQuestions: totalEstimated,
    estimatedDurationSec: totalEstimated * 30,
    competenciesToAssess: Array.from(canonicalRatings.keys()).map(c => ({ name: c, questionCap: 3 })),
  };
}

async function _ensureAttemptPool(attempt) {
  const key = _snapshotKey(attempt);
  const cached = _attemptPoolCache.get(key);
  if (cached && Array.isArray(cached.questions) && cached.questions.length > 0) {
    return cached;
  }

  // Re-derive meta if the cache was lost (e.g., process restart).
  let meta = cached?._meta;
  if (!meta) {
    const { buildTargetKey, canonicalize } = _getTaxonomyHelpers();
    const objId = attempt.objectiveSnapshot?._id;
    let objectiveType = null;
    let targetKey = null;
    if (objId) {
      const obj = await UserObjective.findById(objId).lean();
      if (obj) {
        objectiveType = obj.objectiveType;
        targetKey = buildTargetKey(obj.objectiveType, obj.specificsCanonical || obj.specifics || {});
      }
    }
    meta = { targetKey, objectiveType };
  }

  // Build topicsWithRatings from the attempt's stored canonical selfRatings.
  const ratingsMap = attempt.selfRatings instanceof Map
    ? attempt.selfRatings
    : new Map(Object.entries(attempt.selfRatings || {}));
  const topicsWithRatings = Array.from(ratingsMap.entries()).map(([canonicalName, rating]) => ({
    canonicalName,
    rating,
  }));

  const { assemblePool } = diagnosticPoolService;
  const { questions } = await assemblePool({
    objectiveType: meta.objectiveType,
    targetKey: meta.targetKey,
    topicsWithRatings,
    userId: attempt.userId,
  });

  // Persist refs so other surfaces (abandon %, schema clients) keep working.
  attempt.poolQuestionIds = questions.map(q => q._id).filter(Boolean);
  await attempt.save();

  const entry = { _meta: meta, questions };
  _attemptPoolCache.set(key, entry);
  return entry;
}

async function nextQuestion(attemptId) {
  const attempt = await DiagnosticAttempt.findById(attemptId);
  if (!attempt) throw new Error('attempt not found');

  const pool = await _ensureAttemptPool(attempt);
  const questions = pool.questions || [];

  const answeredIds = new Set((attempt.answers || []).map(a => String(a.questionId)));
  const remaining = questions.filter(q => !answeredIds.has(String(q._id)));

  if (remaining.length === 0) {
    return {
      done: true,
      progress: { current: attempt.answers.length, total: questions.length },
    };
  }

  const next = remaining[0];
  // Best-effort usage tracking.
  DiagnosticQuestionBank.updateOne({ _id: next._id }, { $inc: { timesUsed: 1 } }).catch(() => {});

  // Map canonical → display name for the wire.
  let displayName = next.canonicalCompetency;
  try {
    const Taxonomy = _getTopicTaxonomyModel();
    const tax = await Taxonomy.findOne({
      objectiveType: pool._meta?.objectiveType,
      targetKey: pool._meta?.targetKey,
    }).lean();
    const t = (tax?.topics || []).find(x => x.canonicalName === next.canonicalCompetency);
    if (t?.name) displayName = t.name;
  } catch (_) { /* fall back to canonical */ }

  return {
    done: false,
    question: {
      _id: next._id,
      competency: displayName,
      canonicalCompetency: next.canonicalCompetency,
      difficulty: next.difficulty,
      prompt: next.questionText,
      options: (next.options || []).map(o => ({ key: o.label || o.key, text: o.text })),
      type: next.requiresVoice ? 'voice' : 'mcq',
    },
    progress: { current: attempt.answers.length + 1, total: questions.length },
  };
}

async function submitAnswer(attemptId, questionId, selectedAnswer, timeTaken) {
  const attempt = await DiagnosticAttempt.findById(attemptId);
  if (!attempt) throw new Error('attempt not found');

  // Look up the question in the pool snapshot first (has canonicalCompetency).
  // Fall back to a DB read if the snapshot is gone.
  const pool = _attemptPoolCache.get(_snapshotKey(attempt));
  let q = (pool?.questions || []).find(x => String(x._id) === String(questionId));
  if (!q) {
    q = await DiagnosticQuestionBank.findById(questionId).lean();
  }
  if (!q) throw new Error('question not found');

  const isCorrect = q.correctAnswer === selectedAnswer;

  attempt.answers.push({
    questionId,
    competency: q.canonicalCompetency || '', // canonical throughout
    difficulty: q.difficulty,
    selectedAnswer,
    isCorrect,
    timeTaken: timeTaken || 0,
  });
  await attempt.save();
  return { ack: true };
}

async function finishAttempt(attemptId) {
  const attempt = await DiagnosticAttempt.findById(attemptId);
  if (!attempt) throw new Error('attempt not found');
  if (attempt.status === 'completed') {
    return _resultsObjectFromAttempt(attempt);
  }

  const ratingsMap = attempt.selfRatings instanceof Map
    ? attempt.selfRatings
    : new Map(Object.entries(attempt.selfRatings || {}));

  // Aggregate by canonicalCompetency (stored on answer.competency in v2).
  const byCanonical = new Map();
  for (const ans of attempt.answers || []) {
    const c = ans.competency;
    if (!c) continue;
    if (!byCanonical.has(c)) byCanonical.set(c, { correct: 0, total: 0 });
    const stats = byCanonical.get(c);
    stats.total += 1;
    if (ans.isCorrect) stats.correct += 1;
  }

  // Resolve display names from TopicTaxonomy.
  const pool = _attemptPoolCache.get(_snapshotKey(attempt));
  let displayByCanonical = new Map();
  try {
    const Taxonomy = _getTopicTaxonomyModel();
    const { buildTargetKey } = _getTaxonomyHelpers();
    let objectiveType = pool?._meta?.objectiveType;
    let targetKey = pool?._meta?.targetKey;
    if ((!objectiveType || !targetKey) && attempt.objectiveSnapshot?._id) {
      const obj = await UserObjective.findById(attempt.objectiveSnapshot._id).lean();
      if (obj) {
        objectiveType = obj.objectiveType;
        targetKey = buildTargetKey(obj.objectiveType, obj.specificsCanonical || obj.specifics || {});
      }
    }
    const tax = await Taxonomy.findOne({ objectiveType, targetKey }).lean();
    for (const t of (tax?.topics || [])) {
      displayByCanonical.set(t.canonicalName, t.name);
    }
  } catch (_) { /* fall back to canonical */ }

  // Spec §10.2 — use calibration utility for delta/class consistency
  for (const [canonical, stats] of byCanonical.entries()) {
    const score = stats.total > 0 ? Math.round((stats.correct / stats.total) * 100) : 0;
    const band = calibration.scoreToBand(score).toLowerCase();
    // selfRatings stored lowercase per Plan 2a — calibration utility is case-insensitive
    const selfRating = ratingsMap.get(canonical);
    let calibrationDelta = 0;
    let calibrationClass = 'well-calibrated';
    try {
      calibrationDelta = calibration.calibrationDelta(score, selfRating);
      calibrationClass = calibration.calibrationClass(calibrationDelta);
    } catch (_) {
      // unknown self-rating (legacy attempt) — leave defaults
    }
    attempt.results.set(canonical, {
      assessedBand: band,
      score,
      calibrationDelta,
      calibrationClass,
      questionsAsked: stats.total,
    });
  }

  attempt.status = 'completed';
  attempt.completedAt = new Date();
  attempt.planGenerationStatus = 'pending';
  await attempt.save();

  // Persist re-calibration growth before insights/plan so it's available in results.
  if (attempt.attemptType === 'recalibration') {
    try {
      const recalibrationResultsService = require('./diagnostic/recalibrationResultsService');
      await recalibrationResultsService.persistGrowth(attempt._id);
    } catch (err) {
      console.warn('[diagnosticService] recalibration growth computation failed:', err.message);
    }
  }

  telemetry.logEvent('diagnostic.finished', {
    userId: String(attempt.userId),
    questionsAnswered: attempt.answers.length,
  });

  // Spec §10.5 — foreground insights generation (blocks results return)
  // Lazy require so tests can stub without OPENAI_API_KEY at module load time.
  const insightsGenerationService = require('./diagnostic/insightsGenerationService');
  attempt.insightsStatus = 'generating';
  await attempt.save();

  const insightsInput = {
    objectiveType:      attempt.objectiveSnapshot?.objectiveType || 'upskilling',
    specificsCanonical: attempt.objectiveSnapshot?.specificsCanonical || null,
    timelineWeeks:      attempt.objectiveSnapshot?.timelineWeeks || 12,
    weeklyCommitHours:  attempt.objectiveSnapshot?.weeklyCommitHours || 6,
    companyProfile:     attempt.objectiveSnapshot?.companyProfile || null,
    topics: Array.from(attempt.results.entries()).map(([canonicalName, r]) => ({
      canonicalName,
      name:               displayByCanonical.get(canonicalName) || canonicalName,
      selfRating:         ratingsMap.get(canonicalName),
      measuredScore:      r.score,
      questionsAsked:     r.questionsAsked,
      missedDifficulties: _missedDifficultiesFor(attempt.answers, canonicalName),
    })),
  };

  const t0 = Date.now();
  let insightsResult;
  try {
    insightsResult = await insightsGenerationService.generateInsights(insightsInput);
  } catch (err) {
    console.warn('[diagnosticService] insights generation hard failure:', err.message);
    insightsResult = {
      source: 'template',
      fallbackReason: 'error',
      insights: insightsGenerationService._templateInsights(insightsInput),
    };
  }

  attempt.insightsJson      = insightsResult.insights;
  attempt.insightsSource    = insightsResult.source;
  attempt.insightsStatus    = insightsResult.source === 'llm' ? 'completed' : 'fallback';
  attempt.insightsLatencyMs = Date.now() - t0;
  await attempt.save();

  telemetry.logEvent('diagnostic.insights_generated', {
    userId: String(attempt.userId),
    source: insightsResult.source,
    fallbackReason: insightsResult.fallbackReason || null,
    latencyMs: attempt.insightsLatencyMs,
  });

  try {
    await DiagnosticAttempt.updateOne(
      { _id: attempt._id },
      { $set: { planGenerationStatus: 'generating' } }
    );
    await planGenerationQueue.add(
      'generate',
      { attemptId: String(attempt._id) },
      { attempts: 2, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: 50 }
    );
  } catch (err) {
    console.warn('[diagnosticService] failed to enqueue plan generation:', err.message);
  }

  return _resultsObjectFromAttempt(attempt, displayByCanonical);
}

function _resultsObjectFromAttempt(attempt, displayByCanonical = new Map()) {
  const results = [];
  for (const [canonical, v] of attempt.results.entries()) {
    results.push({
      competency: displayByCanonical.get(canonical) || canonical,
      canonicalCompetency: canonical,
      band: v.assessedBand,
      score: v.score,
      calibrationDelta: v.calibrationDelta,
      calibrationClass: v.calibrationClass || 'well-calibrated',
      questionsAsked: v.questionsAsked,
    });
  }
  return {
    attemptId: String(attempt._id),
    status: attempt.status,
    insightsStatus: attempt.insightsStatus || 'pending',
    insights: attempt.insightsJson || null,
    planStatus: attempt.appliedToProfileAt ? 'queued' : 'pending',
    results,
  };
}

function _missedDifficultiesFor(answers, comp) {
  const missed = new Set();
  for (const a of answers) {
    if (a.competency === comp && a.isCorrect === false && a.difficulty) {
      missed.add(a.difficulty);
    }
  }
  return Array.from(missed);
}

// ---------------------------------------------------------------------------
// Re-calibration flow (Plan 4 Task 9)
// ---------------------------------------------------------------------------

async function startRecalibration(userId, opts = {}) {
  const recalibrationEligibilityService = require('./diagnostic/recalibrationEligibilityService');
  const eligibility = await recalibrationEligibilityService.computeEligibility(userId, {
    userFlaggedTopics: opts.userFlaggedTopics || [],
  });
  if (!eligibility.eligible) {
    throw Object.assign(new Error('Not eligible for re-calibration'), { code: 'NOT_ELIGIBLE', meta: eligibility });
  }

  const previousAttempt = await DiagnosticAttempt.findById(eligibility.previousAttemptId).lean();
  const objectiveId = previousAttempt?.objectiveSnapshot?._id;
  const objective = await UserObjective.findById(objectiveId).lean();

  // Lazy require so tests can stub via require.cache
  const diagnosticSelectorService = require('./diagnosticSelectorService');
  const pool = await diagnosticSelectorService.selectQuestions({
    userId,
    objective,
    onlyTopics: eligibility.eligibleTopics,
    questionsPerTopicCap: 2,
    skipAnchorBoost: true,
  });

  const attempt = await DiagnosticAttempt.create({
    userId,
    flowType: 'recalibration',
    attemptType: 'recalibration',
    previousAttemptId: eligibility.previousAttemptId,
    poolQuestionIds: pool.map(q => q._id),
    selfRatings: previousAttempt?.selfRatings || new Map(),
    objectiveSnapshot: {
      _id: objectiveId,
      label: objective?.specifics?.targetRole || objective?.objectiveType,
    },
    status: 'in_progress',
    planGenerationStatus: 'pending',
  });

  return {
    attemptId: attempt._id,
    totalEstimatedQuestions: pool.length,
    estimatedDurationSec: pool.length * 25,
    flowType: 'recalibration',
  };
}

module.exports = {
  startAttempt,
  submitSelfRating,
  nextQuestion,
  submitAnswer,
  finishAttempt,
  abandon,
  getSynthesis,
  startRecalibration,
  _internal: {
    _attemptPoolCache,
    _missedDifficultiesFor,
  },
};
