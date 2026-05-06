/**
 * Diagnostic Service — orchestrates a single diagnostic attempt across its lifecycle.
 *
 * Public API:
 *   startAttempt(userId)              → { attemptId, flowType, competenciesToAssess }
 *   submitSelfRating(attemptId, ...)  → kicks off pool generation, returns when ready
 *   nextQuestion(attemptId)           → { question } or { done: true }
 *   submitAnswer(attemptId, ...)      → { ack: true }
 *   finishAttempt(attemptId)          → results
 *   abandon(attemptId)                → handles 3-tier abandonment policy
 */

const mongoose = require('mongoose');
const telemetry = require('./diagnosticTelemetryService');
const userContextService = require('./userContextService');
const DiagnosticAttempt = require('../models/DiagnosticAttempt');
const KnowledgeProfile = require('../models/KnowledgeProfile');
const ConceptMastery = require('../models/ConceptMastery');
const UserObjective = require('../models/UserObjective');
const diagnosticPoolService = require('./diagnosticPoolService');
const DiagnosticQuestionBank = require('../models/DiagnosticQuestionBank');
const selector = require('./diagnosticSelectorService');
const { normalize } = require('./competencyNormalizer');

const RATING_TO_NUM = { novice: 0, familiar: 1, proficient: 2, expert: 3, unsure: 0 };

const CONFIDENCE_LOW_THRESHOLD_S = 5;
const CONFIDENCE_MEDIUM_THRESHOLD_S = 12;
const ACTIVE_ATTEMPT_STATUSES = ['in_progress'];

/**
 * Decide flow type based on prior platform activity.
 * 5+ completed quizzes = enough signal to scope existing-user flow meaningfully;
 * fewer means treat as new and run the full diagnostic.
 */
const EXISTING_USER_QUIZ_THRESHOLD = 5;

function _decideFlowType(profile) {
  if (profile && (profile.totalQuizzesTaken || 0) >= EXISTING_USER_QUIZ_THRESHOLD) {
    return 'existing_user_tune';
  }
  return 'new_user';
}

/**
 * For existing-user flow: how many questions to ask about a competency given
 * existing KnowledgeProfile signal. See spec §4 Screen E4.
 */
function questionCapForCompetency(profile, competency) {
  const tm = profile?.topicMastery?.find(t => (t.topic || '').toLowerCase() === competency.toLowerCase());
  if (!tm) return 3; // Never seen → full scope
  const attempts = tm.quizzesTaken || 0;
  if (attempts === 0) return 3;
  // Score variance: stdev of recent scoreHistory
  const scores = (tm.scoreHistory || []).map(h => h.score || 0).slice(-5);
  let variance = 0;
  if (scores.length >= 2) {
    const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
    variance = Math.sqrt(scores.reduce((s, v) => s + (v - mean) ** 2, 0) / scores.length);
  }
  if (attempts >= 5 && variance < 15) return 0;          // Strong, stable signal
  if (attempts >= 2 || variance >= 15) return 1;          // Some signal, disambiguate
  return 2;                                               // Weak signal
}

const RETAKE_COOLDOWN_DAYS = Number(process.env.DIAGNOSTIC_RETAKE_COOLDOWN_DAYS ?? 30);
const RETAKE_COOLDOWN_MS = RETAKE_COOLDOWN_DAYS * 86400000;

async function startAttemptV1(userId) {
  const [profile, objective] = await Promise.all([
    KnowledgeProfile.findOne({ userId }),
    UserObjective.findOne({ userId, status: 'active', isPrimary: true }).lean(),
  ]);

  const competencies = objective?.analysis?.competencies || [];
  if (!competencies.length) return null; // caller routes to fallback (Edge 7)

  // Retake cooldown: reject if a completed attempt exists within 30 days
  // unless the user's objective has changed since that attempt.
  const lastCompleted = await DiagnosticAttempt.findOne(
    { userId, status: 'completed' },
    null,
    { sort: { completedAt: -1 } },
  );

  if (lastCompleted && lastCompleted.completedAt) {
    const ageMs = Date.now() - new Date(lastCompleted.completedAt).getTime();
    const lastObjId = lastCompleted.objectiveSnapshot?._id;
    const currObjId = objective?._id;
    const sameObjective = !!lastObjId && !!currObjId && String(lastObjId) === String(currObjId);
    if (ageMs < RETAKE_COOLDOWN_MS && sameObjective) {
      return null;
    }
  }

  // Abandon any prior in-progress / awaiting_self_rating attempts before creating a new one.
  // This keeps the partial unique index (one_active_attempt_per_user) clean and makes the
  // user's intent to start fresh explicit.
  await DiagnosticAttempt.updateMany(
    { userId, status: { $in: ACTIVE_ATTEMPT_STATUSES } },
    { $set: { status: 'abandoned', abandonedAt: new Date() } },
  );

  const flowType = _decideFlowType(profile);

  const objectiveLabel = objective
    ? (objective.specifics?.examName || objective.objectiveType || null)
    : null;

  const attempt = new DiagnosticAttempt({
    userId,
    flowType,
    status: 'in_progress',
    startedAt: new Date(),
    objectiveSnapshot: objective
      ? { _id: objective._id, label: objectiveLabel }
      : null,
  });
  await attempt.save();
  telemetry.logEvent('diagnostic.started', { userId: String(userId), flowType });

  let competenciesToAssess = competencies.map(c => ({ name: c.name, questionCap: 3 }));
  if (flowType === 'existing_user_tune' && profile) {
    competenciesToAssess = competenciesToAssess
      .map(c => ({ ...c, questionCap: questionCapForCompetency(profile, c.name) }))
      .filter(c => c.questionCap > 0);
  }

  return {
    attemptId: attempt._id,
    flowType,
    competenciesToAssess,
  };
}

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

function _perfForCompetency(answers, competency) {
  const filt = answers.filter(a => a.competency === competency);
  return ['easy', 'medium', 'hard'].reduce((acc, d) => {
    acc[d] = {
      correct: filt.filter(a => a.difficulty === d && a.isCorrect).length,
      wrong:   filt.filter(a => a.difficulty === d && !a.isCorrect).length,
    };
    return acc;
  }, {});
}

async function nextQuestionV1(attemptId) {
  const attempt = await DiagnosticAttempt.findById(attemptId);
  if (!attempt) throw new Error('attempt not found');

  // Batch-fetch all pool questions in one query (I1: avoid N+1 reads)
  const poolQuestionIds = attempt.poolQuestionIds || [];
  const poolDocs = await DiagnosticQuestionBank.find({ _id: { $in: poolQuestionIds } }).lean();
  const poolMap = new Map(poolDocs.map(d => [String(d._id), d]));

  // Find the next competency to ask about — first one that hasn't converged
  const competencies = Array.from(attempt.selfRatings.keys());
  for (const comp of competencies) {
    const perf = _perfForCompetency(attempt.answers, comp);
    const asked = attempt.answers.filter(a => a.competency === comp).length;
    const lastForComp = attempt.answers.filter(a => a.competency === comp).slice(-1)[0];
    const decision = selector.selectNext({
      perf,
      questionsAsked: asked,
      selfRating: attempt.selfRatings.get(comp),
      currentDifficulty: lastForComp?.difficulty,
      lastAnswer: lastForComp ? { correct: lastForComp.isCorrect, fast: (lastForComp.timeTaken || 99) < 15 } : null,
    });
    if (decision.shouldStop) continue;

    const compCanonical = normalize(comp);

    // Find a pool question matching (competency, difficulty), not already used
    const usedIds = new Set(attempt.answers.map(a => String(a.questionId)));
    for (const qid of poolQuestionIds) {
      if (usedIds.has(String(qid))) continue;
      const q = poolMap.get(String(qid));
      if (!q) continue;
      if (q.difficulty !== decision.nextDifficulty) continue;
      // Normalize both sides — bank stores canonical, attempt has raw competency name.
      if (q.canonicalCompetency && q.canonicalCompetency !== compCanonical) continue;
      DiagnosticQuestionBank.updateOne({ _id: q._id }, { $inc: { timesUsed: 1 } }).catch(() => {});
      return {
        done: false,
        question: {
          _id: q._id, competency: comp, difficulty: q.difficulty,
          prompt: q.questionText,
          options: (q.options || []).map(o => ({ key: o.label || o.key, text: o.text })),
        },
      };
    }
    // No matching question in pool — try any difficulty for this competency
    for (const qid of poolQuestionIds) {
      if (usedIds.has(String(qid))) continue;
      const q = poolMap.get(String(qid));
      if (q && q.canonicalCompetency === compCanonical) {
        DiagnosticQuestionBank.updateOne({ _id: q._id }, { $inc: { timesUsed: 1 } }).catch(() => {});
        return {
          done: false,
          question: {
            _id: q._id, competency: comp, difficulty: q.difficulty,
            prompt: q.questionText,
            options: (q.options || []).map(o => ({ key: o.label || o.key, text: o.text })),
          },
        };
      }
    }
  }
  return { done: true };
}

async function submitAnswerV1(attemptId, questionId, selectedAnswer, timeTaken) {
  const attempt = await DiagnosticAttempt.findById(attemptId);
  if (!attempt) throw new Error('attempt not found');
  const q = await DiagnosticQuestionBank.findById(questionId);
  if (!q) throw new Error('question not found');

  // Store competency under the same name selfRatings is keyed by (raw user-facing
  // form like "Product Metrics & Analytics"), so per-competency filters in
  // nextQuestion/finishAttempt match. Bank stores canonical; reverse-lookup here.
  const selfRatingsKeys = attempt.selfRatings ? Array.from(attempt.selfRatings.keys()) : [];
  const rawCompetency =
    selfRatingsKeys.find(k => normalize(k) === q.canonicalCompetency)
    || q.canonicalCompetency;

  const isCorrect = q.correctAnswer === selectedAnswer;
  attempt.answers.push({
    questionId,
    competency: rawCompetency,
    difficulty: q.difficulty,
    selectedAnswer,
    isCorrect,
    timeTaken: timeTaken || 0,
  });
  await attempt.save();
  return { ack: true };
}

async function finishAttemptV1(attemptId) {
  const attempt = await DiagnosticAttempt.findById(attemptId);
  if (!attempt) throw new Error('attempt not found');
  if (attempt.status === 'completed') {
    return _resultsObjectFromAttempt(attempt);
  }

  // Compute per-competency results
  for (const comp of attempt.selfRatings.keys()) {
    const perf = _perfForCompetency(attempt.answers, comp);
    const band = selector._internal.deriveBand(perf);
    const score = selector._internal.bandToScore(band);
    const selfRatingNum = RATING_TO_NUM[attempt.selfRatings.get(comp)] ?? 0;
    const assessedNum = RATING_TO_NUM[band];
    const calibrationDelta = selfRatingNum - assessedNum; // positive = over-confident
    const questionsAsked = attempt.answers.filter(a => a.competency === comp).length;
    attempt.results.set(comp, { assessedBand: band, score, calibrationDelta, questionsAsked });
  }

  const totalTime = attempt.answers.reduce((s, a) => s + (a.timeTaken || 0), 0);
  // Zero answers (e.g., abandon-then-finish race): treat as full confidence.
  const avgTime = attempt.answers.length > 0 ? totalTime / attempt.answers.length : Infinity;
  attempt.confidence = avgTime < CONFIDENCE_LOW_THRESHOLD_S
    ? 'low'
    : avgTime < CONFIDENCE_MEDIUM_THRESHOLD_S
    ? 'medium'
    : 'high';

  attempt.status = 'completed';
  attempt.completedAt = new Date();
  await attempt.save();

  // Apply to KnowledgeProfile; stamp idempotency checkpoint on success (I5)
  await _applyToKnowledgeProfile(attempt)
    .then(async () => {
      attempt.appliedToProfileAt = new Date();
      await attempt.save();
    })
    .catch(err =>
      console.warn('[diagnosticService] KnowledgeProfile update failed:', err.message),
    );

  // Seed ConceptMastery
  await _seedConceptMastery(attempt).catch(err =>
    console.warn('[diagnosticService] ConceptMastery seed failed:', err.message),
  );

  // Trigger plan regeneration with diagnostic data injected.
  // Best-effort — don't block the response if the journey service is busy.
  try {
    const journeyService = require('./journeyGenerationService');
    if (typeof journeyService.regenerateForUser === 'function') {
      const diagnosticData = {};
      for (const [k, v] of attempt.results.entries()) diagnosticData[k] = v;
      await journeyService.regenerateForUser(attempt.userId, { diagnosticData });
    }
  } catch (err) {
    console.warn('[diagnosticService] plan regenerate failed:', err.message);
  }

  telemetry.logEvent('diagnostic.finished', { userId: String(attempt.userId), questionsAnswered: attempt.answers.length });
  return _resultsObjectFromAttempt(attempt);
}

function _resultsObjectFromAttempt(attempt) {
  // Wire shape required by iOS/RN clients:
  //   { attemptId, status, results: [ { competency, band, score, calibrationDelta, questionsAsked } ] }
  const results = [];
  for (const [comp, v] of attempt.results.entries()) {
    results.push({
      competency: comp,
      band: v.assessedBand,
      score: v.score,
      calibrationDelta: v.calibrationDelta,
      questionsAsked: v.questionsAsked,
    });
  }
  return {
    attemptId: String(attempt._id),
    status: attempt.status,
    results,
  };
}

async function _applyToKnowledgeProfile(attempt) {
  const kp = await KnowledgeProfile.findOne({ userId: attempt.userId });
  if (!kp) return;
  const now = new Date();
  const objectiveId = attempt.objectiveSnapshot?._id || null;
  for (const [comp, res] of attempt.results.entries()) {
    // Scope match to (topic, objectiveId) so users with multiple objectives
    // don't have mastery for one objective overwritten by another.
    let entry = kp.topicMastery.find(
      t => t.topic === comp && String(t.objectiveId || '') === String(objectiveId || ''),
    );
    if (!entry) {
      entry = { topic: comp, objectiveId, scoreHistory: [] };
      kp.topicMastery.push(entry);
    }
    entry.score = res.score;
    entry.lastAssessedAt = now;
    entry.selfRating = attempt.selfRatings.get(comp);
    entry.calibrationAtBaseline = { delta: res.calibrationDelta, capturedAt: now };
  }
  await kp.save();
}

async function _seedConceptMastery(attempt) {
  // Best-effort: each competency gets one ConceptMastery row seeded with the
  // assessed score; spaced-repetition takes over from here on subsequent quizzes.
  const now = new Date();
  for (const [comp, res] of attempt.results.entries()) {
    const stability = res.score >= 70 ? 7 : res.score >= 50 ? 3 : 1;
    await ConceptMastery.findOneAndUpdate(
      { userId: attempt.userId, concept: comp },
      {
        $setOnInsert: {
          userId: attempt.userId, concept: comp,
          stability, difficulty: 5.0, reps: 1, lapses: 0,
          lastReviewedAt: now,
          nextReviewAt: new Date(now.getTime() + stability * 86400000),
        },
      },
      { upsert: true, new: true },
    );
  }
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
// V2 path (Plan 3a Task 8): taxonomy-driven, canonical-name-throughout.
// Gated on FEATURE_DAY1_DIAGNOSTIC_V2 === 'true'. V1 above is preserved.
// ---------------------------------------------------------------------------

// Lazy require so the v1 path doesn't pay any load-time cost when V2 is off.
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
// schema only stores `poolQuestionIds` (refs); v2 needs the *full* question
// docs (with canonicalCompetency, correctAnswer) on every nextQuestion /
// submitAnswer call. Keeping a snapshot in-memory avoids refactoring the
// schema during Plan 3a. Production uses sticky sessions; if that changes,
// rehydrate from DiagnosticQuestionBank by id.
const _v2PoolCache = new Map(); // attemptId(string) -> [questionDoc, ...]

function _snapshotKey(attempt) {
  return String(attempt._id);
}

async function startAttemptV2(userId) {
  const { canonicalize, buildTargetKey } = _getTaxonomyHelpers();
  const { totalQuestionsForAttempt } = _getSelectorPlan();

  const objective = await UserObjective.findOne({ userId, status: 'active', isPrimary: true }).lean()
    || await UserObjective.findOne({ userId, status: 'active' }).lean();
  if (!objective) return null;

  // Canonicalize topicSelfRatings keys (display names → canonical).
  const ratingsRaw = objective.topicSelfRatings || new Map();
  const ratingsIter = ratingsRaw instanceof Map
    ? Array.from(ratingsRaw.entries())
    : Object.entries(ratingsRaw);
  const canonicalRatings = new Map();
  for (const [name, rating] of ratingsIter) {
    if (!rating) continue;
    canonicalRatings.set(canonicalize(name), rating);
  }
  if (canonicalRatings.size === 0) return null; // caller falls back

  const targetKey = buildTargetKey(
    objective.objectiveType,
    objective.specificsCanonical || objective.specifics || {},
  );

  // Abandon any prior in-progress attempts (mirrors v1 invariant).
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
  _v2PoolCache.set(_snapshotKey(attempt), { _meta: { targetKey, objectiveType: objective.objectiveType } });

  telemetry.logEvent('diagnostic.started', { userId: String(userId), flowType: 'new_user', v2: true });

  return {
    attemptId: attempt._id,
    flowType: 'new_user',
    totalEstimatedQuestions: totalEstimated,
    estimatedDurationSec: totalEstimated * 30,
    // Mirror v1's competenciesToAssess so callers that read it still work.
    competenciesToAssess: Array.from(canonicalRatings.keys()).map(c => ({ name: c, questionCap: 3 })),
  };
}

async function _ensureV2Pool(attempt) {
  const key = _snapshotKey(attempt);
  const cached = _v2PoolCache.get(key);
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
  _v2PoolCache.set(key, entry);
  return entry;
}

async function nextQuestionV2(attemptId) {
  const attempt = await DiagnosticAttempt.findById(attemptId);
  if (!attempt) throw new Error('attempt not found');

  const pool = await _ensureV2Pool(attempt);
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
  // Best-effort usage tracking; mirrors v1.
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

async function submitAnswerV2(attemptId, questionId, selectedAnswer, timeTaken) {
  const attempt = await DiagnosticAttempt.findById(attemptId);
  if (!attempt) throw new Error('attempt not found');

  // Look up the question in the pool snapshot first (has canonicalCompetency).
  // Fall back to a DB read if the snapshot is gone.
  const pool = _v2PoolCache.get(_snapshotKey(attempt));
  let q = (pool?.questions || []).find(x => String(x._id) === String(questionId));
  if (!q) {
    q = await DiagnosticQuestionBank.findById(questionId).lean();
  }
  if (!q) throw new Error('question not found');

  const isCorrect = q.correctAnswer === selectedAnswer;

  attempt.answers.push({
    questionId,
    competency: q.canonicalCompetency || '', // canonical throughout v2
    difficulty: q.difficulty,
    selectedAnswer,
    isCorrect,
    timeTaken: timeTaken || 0,
  });
  await attempt.save();
  return { ack: true };
}

async function finishAttemptV2(attemptId) {
  const attempt = await DiagnosticAttempt.findById(attemptId);
  if (!attempt) throw new Error('attempt not found');
  if (attempt.status === 'completed') {
    return _resultsObjectFromAttemptV2(attempt);
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
  const pool = _v2PoolCache.get(_snapshotKey(attempt));
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

  // Persist results into the schema's results Map (keyed by canonical for v2).
  for (const [canonical, stats] of byCanonical.entries()) {
    const score = stats.total > 0 ? Math.round((stats.correct / stats.total) * 100) : 0;
    const band = score < 30 ? 'novice'
      : score < 55 ? 'familiar'
      : score < 80 ? 'proficient'
      : 'expert';
    const ratingMidpoint = { novice: 15, familiar: 42, proficient: 67, expert: 90 }[ratingsMap.get(canonical)] ?? 50;
    attempt.results.set(canonical, {
      assessedBand: band,
      score,
      calibrationDelta: score - ratingMidpoint,
      questionsAsked: stats.total,
    });
  }

  attempt.status = 'completed';
  attempt.completedAt = new Date();
  attempt.planGenerationStatus = 'pending';
  await attempt.save();

  telemetry.logEvent('diagnostic.finished', {
    userId: String(attempt.userId),
    questionsAnswered: attempt.answers.length,
    v2: true,
  });

  return _resultsObjectFromAttemptV2(attempt, displayByCanonical);
}

function _resultsObjectFromAttemptV2(attempt, displayByCanonical = new Map()) {
  const results = [];
  for (const [canonical, v] of attempt.results.entries()) {
    results.push({
      competency: displayByCanonical.get(canonical) || canonical,
      canonicalCompetency: canonical,
      band: v.assessedBand,
      score: v.score,
      calibrationDelta: v.calibrationDelta,
      questionsAsked: v.questionsAsked,
    });
  }
  return {
    attemptId: String(attempt._id),
    status: attempt.status,
    results,
  };
}

// ---------------------------------------------------------------------------
// Public dispatchers — feature-flag routing between V1 (default) and V2.
// ---------------------------------------------------------------------------

function _useV2() {
  return process.env.FEATURE_DAY1_DIAGNOSTIC_V2 === 'true';
}

async function startAttempt(userId) {
  return _useV2() ? startAttemptV2(userId) : startAttemptV1(userId);
}
async function nextQuestion(attemptId) {
  return _useV2() ? nextQuestionV2(attemptId) : nextQuestionV1(attemptId);
}
async function submitAnswer(attemptId, questionId, selectedAnswer, timeTaken) {
  return _useV2()
    ? submitAnswerV2(attemptId, questionId, selectedAnswer, timeTaken)
    : submitAnswerV1(attemptId, questionId, selectedAnswer, timeTaken);
}
async function finishAttempt(attemptId) {
  return _useV2() ? finishAttemptV2(attemptId) : finishAttemptV1(attemptId);
}

module.exports = {
  startAttempt,
  submitSelfRating,
  nextQuestion,
  submitAnswer,
  finishAttempt,
  abandon,
  getSynthesis,
  _internal: {
    _decideFlowType,
    questionCapForCompetency,
    // V2 internals exposed for testing
    startAttemptV2,
    nextQuestionV2,
    submitAnswerV2,
    finishAttemptV2,
    _v2PoolCache,
  },
};
