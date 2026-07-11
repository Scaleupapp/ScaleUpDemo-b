'use strict';
// Engine adapters — the only assessment code that knows engine specifics.
// Each adapter exposes start(assessment, userId, deps) and readResult(session, deps).
// `deps` injects models/services for testing.

const { _helpers: qaHelpers } = require('./questionQaService');

// ── Deterministic per-student sampling + shuffle ──────────────────────────────
// A student's served set is a DETERMINISTIC function of (userId, assessmentId):
// re-entry yields the identical sample + question order + option order, so a
// resumed attempt is stable while different students see different variants.

const OPTION_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

/** xmur3 string hash → 32-bit seed. */
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** mulberry32 PRNG from a 32-bit seed → deterministic float in [0,1). */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seedStr) {
  return mulberry32(xmur3(String(seedStr))());
}

/** Fisher-Yates in place using an injected rng. */
function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  return arr;
}

/** Shuffle a question's options and remap the key label to its new position. */
function shuffleOptions(q, rng) {
  const clone = { ...q };
  delete clone.qa; // internal QA metadata never reaches the served quiz
  const opts = Array.isArray(q.options) ? q.options : null;
  if (!opts || opts.length === 0) return clone;

  const { keyIndex } = qaHelpers.normalizeQuestion(q);
  const indexed = opts.map((o, i) => ({ o, isKey: i === keyIndex }));
  shuffleInPlace(indexed, rng);

  clone.options = indexed.map((entry, i) => {
    const label = OPTION_LETTERS[i] || String.fromCharCode(65 + i);
    if (entry.o && typeof entry.o === 'object') return { ...entry.o, label };
    return entry.o; // string options carry their position implicitly
  });

  if (keyIndex >= 0) {
    const newKeyPos = indexed.findIndex((e) => e.isKey);
    clone.correctAnswer = OPTION_LETTERS[newKeyPos] || String.fromCharCode(65 + newKeyPos);
  }
  return clone;
}

/**
 * Deterministically sample `count` questions from `pool`, shuffle their order,
 * and shuffle each question's options (with key remap). Frozen pool untouched.
 */
function buildServedQuestions(pool, count, seedStr) {
  const list = Array.isArray(pool) ? pool : [];
  const n = Math.min(count, list.length);
  const rng = makeRng(seedStr);
  const idxs = shuffleInPlace(list.map((_, i) => i), rng).slice(0, n);
  return idxs.map((i) => shuffleOptions(list[i], rng));
}

const mcq = {
  // Sample a per-student servable set from the frozen QA-passed pool, then open an attempt.
  async start(assessment, userId, deps = {}) {
    const Quiz = deps.Quiz || require('../../../models/Quiz');
    const QuizAttempt = deps.QuizAttempt || require('../../../models/QuizAttempt');
    const cfg = (assessment.config && assessment.config.mcq) || {};
    const pool = Array.isArray(cfg.questions) ? cfg.questions : [];
    const perStudentCount = cfg.questionCount || cfg.totalQuestions || pool.length;
    const seed = `${userId}:${assessment._id}`;
    const served = buildServedQuestions(pool, perStudentCount, seed);
    const quiz = await Quiz.create({
      userId,
      title: assessment.title,
      type: 'competency_assessment',
      assessmentType: cfg.assessmentType || 'mixed',
      topic: cfg.topic,
      questions: served,
      totalQuestions: served.length,
      status: 'in_progress',
      source: 'institution_assessment',
      assessmentId: assessment._id,
    });
    const attempt = await QuizAttempt.create({ userId, quizId: quiz._id, answers: [], startedAt: new Date(), status: 'in_progress' });
    return { engine: { type: 'mcq', quizId: quiz._id, sessionId: attempt._id } };
  },
  async readResult(session, deps = {}) {
    const QuizAttempt = deps.QuizAttempt || require('../../../models/QuizAttempt');
    const att = await QuizAttempt.findById(session.engine.sessionId);
    if (!att || att.status !== 'completed') return { done: false };
    return {
      done: true,
      score: att.score ? att.score.percentage : undefined,
      raw: { competencyBreakdown: att.competencyBreakdown, topicBreakdown: att.topicBreakdown },
    };
  },
  async getStartMeta(_session, _deps = {}) {
    return {};
  },
};

const capstone = {
  async start(assessment, userId, deps = {}) {
    const startCapstone = deps.startCapstone || require('../../../coding/services/capstoneSessionService').startSession;
    const cfg = (assessment.config && assessment.config.capstone) || {};
    const { session } = await startCapstone({ userId, bundleId: cfg.bundleId });
    return { engine: { type: 'capstone', sessionId: session._id } };
  },
  async readResult(session, deps = {}) {
    const CapstoneSession = deps.CapstoneSession || require('../../../coding/models/capstoneSession.model');
    const s = await CapstoneSession.findById(session.engine.sessionId);
    if (!s || s.status !== 'graded' || !s.result) return { done: false };
    return { done: true, score: s.result.overall_score, integrity: s.result.integrity_confidence, raw: { dimension_scores: s.result.dimension_scores } };
  },
  async getStartMeta(session, deps = {}) {
    const pairingService = deps.pairingService || require('../../../coding/services/pairingService');
    const CapstoneSession = deps.CapstoneSession || require('../../../coding/models/capstoneSession.model');
    const { code, expiresAt } = await pairingService.mintCode({
      userId: session.userId,
      sessionId: session.engine.sessionId,
    });
    const cs = await CapstoneSession.findById(session.engine.sessionId);
    return {
      pairingCode: code,
      expiresAt,
      timeBudgetSeconds: cs ? cs.time_budget_seconds : undefined,
    };
  },
};

const INTERVIEW_CONTEXT_LIMIT = 4000;

const interview = {
  async start(assessment, userId, deps = {}) {
    const interviewService = deps.interviewService || require('../../interviewService');
    const cfg = (assessment.config && assessment.config.interview) || {};

    // ── Grounding: load AssessmentSource when sourceId is configured ───────────
    let context = '';
    if (cfg.sourceId) {
      const AssessmentSource =
        deps.AssessmentSource || require('../../../models/AssessmentSource');
      try {
        const source = await AssessmentSource.findById(cfg.sourceId);
        if (source && source.status === 'ready' && source.extractedText) {
          context = source.extractedText.slice(0, INTERVIEW_CONTEXT_LIMIT);
        }
      } catch (err) {
        console.warn('[engineAdapters:interview.start] Could not load AssessmentSource:', err.message);
      }
    }

    const out = await interviewService.startInterview(userId, {
      interviewType: cfg.interviewType,
      targetRole: cfg.targetRole,
      difficulty: cfg.difficulty || 'moderate',
      abandonExisting: false,
      context,
    });
    const sid = out && out.session ? out.session._id : (out && out._id);
    return { engine: { type: 'interview', sessionId: sid } };
  },
  async readResult(session, deps = {}) {
    const InterviewSession = deps.InterviewSession || require('../../../models/InterviewSession');
    const s = await InterviewSession.findById(session.engine.sessionId);
    if (!s || s.status !== 'evaluated' || !s.evaluation) return { done: false };
    return { done: true, score: s.evaluation.overallScore, integrity: s.evaluation.integrityReport ? s.evaluation.integrityReport.overallIntegrity : undefined, raw: { dimensions: { communication: s.evaluation.communication, content: s.evaluation.content, structure: s.evaluation.structure, confidence: s.evaluation.confidence } } };
  },
  async getStartMeta(session, deps = {}) {
    const InterviewSession = deps.InterviewSession || require('../../../models/InterviewSession');
    const s = await InterviewSession.findById(session.engine.sessionId);
    return { systemInstruction: s ? s.systemInstruction : undefined };
  },
};

const drill = {
  async start(assessment, userId, deps = {}) {
    const DrillAttempt = deps.DrillAttempt || require('../../../coding/models/drillAttempt.model');
    const cfg = (assessment.config && assessment.config.drill) || {};
    const bundleId = cfg.bundleId;
    const attempt = await DrillAttempt.create({
      user_id: userId,
      bundle_id: bundleId,
      drill_subtype: cfg.drillSubtype,
      status: 'in_progress',
      started_at: new Date(),
    });
    return { engine: { type: 'drill', sessionId: attempt._id, bundleId } };
  },
  async readResult(session, deps = {}) {
    const DrillAttempt = deps.DrillAttempt || require('../../../coding/models/drillAttempt.model');
    const attempt = await DrillAttempt.findById(session.engine.sessionId);
    if (!attempt || attempt.status !== 'graded') return { done: false };
    return {
      done: true,
      score: attempt.grade.overall_score,
      integrity: attempt.grade.integrity_confidence,
      raw: {
        rubric_breakdown: attempt.grade.rubric_breakdown,
        what_you_missed: attempt.grade.what_you_missed,
      },
    };
  },
  async getStartMeta(session, deps = {}) {
    const ArtifactBundle = deps.ArtifactBundle || require('../../../coding/models/artifactBundle.model');
    const { safeBundleView } = require('../../../coding/controllers/drills.controller');
    const bundle = await ArtifactBundle.findById(session.engine.bundleId);
    if (!bundle) return {};
    return safeBundleView(bundle, session.engine.sessionId);
  },
};

const ADAPTERS = { mcq, capstone, interview, drill };

function getAdapter(type) {
  const a = ADAPTERS[type];
  if (!a) throw new Error(`UNKNOWN_ENGINE:${type}`);
  return a;
}

module.exports = { getAdapter, _helpers: { buildServedQuestions, shuffleOptions, makeRng, shuffleInPlace } };
