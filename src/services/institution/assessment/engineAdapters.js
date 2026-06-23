'use strict';
// Engine adapters — the only assessment code that knows engine specifics.
// Each adapter exposes start(assessment, userId, deps) and readResult(session, deps).
// `deps` injects models/services for testing.

const mcq = {
  // Clone the frozen canonical question set into a per-student Quiz, then open an attempt.
  async start(assessment, userId, deps = {}) {
    const Quiz = deps.Quiz || require('../../../models/Quiz');
    const QuizAttempt = deps.QuizAttempt || require('../../../models/QuizAttempt');
    const cfg = (assessment.config && assessment.config.mcq) || {};
    const quiz = await Quiz.create({
      userId,
      title: assessment.title,
      type: 'competency_assessment',
      assessmentType: cfg.assessmentType || 'mixed',
      topic: cfg.topic,
      questions: cfg.questions || [],
      totalQuestions: cfg.totalQuestions || (cfg.questions ? cfg.questions.length : 0),
      status: 'in_progress',
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
};

const capstone = {
  async start(assessment, userId, deps = {}) {
    // TODO(capstone-start-wire): src/coding/services/capstoneSessionService.js does not exist.
    // When that service is created, wire its startSession export here as the production default.
    // Tests always inject deps.startCapstone so tests pass regardless.
    const startCapstone = deps.startCapstone || function () { throw new Error('CAPSTONE_START_UNWIRED'); };
    const cfg = (assessment.config && assessment.config.capstone) || {};
    const s = await startCapstone({ userId, bundleId: cfg.bundleId });
    return { engine: { type: 'capstone', sessionId: s._id } };
  },
  async readResult(session, deps = {}) {
    const CapstoneSession = deps.CapstoneSession || require('../../../coding/models/capstoneSession.model');
    const s = await CapstoneSession.findById(session.engine.sessionId);
    if (!s || s.status !== 'graded' || !s.result) return { done: false };
    return { done: true, score: s.result.overall_score, integrity: s.result.integrity_confidence, raw: { dimension_scores: s.result.dimension_scores } };
  },
};

const interview = {
  async start(assessment, userId, deps = {}) {
    const interviewService = deps.interviewService || require('../../interviewService');
    const cfg = (assessment.config && assessment.config.interview) || {};
    const out = await interviewService.startInterview(userId, {
      interviewType: cfg.interviewType,
      targetRole: cfg.targetRole,
      difficulty: cfg.difficulty || 'moderate',
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
};

const ADAPTERS = { mcq, capstone, interview };

function getAdapter(type) {
  const a = ADAPTERS[type];
  if (!a) throw new Error(`UNKNOWN_ENGINE:${type}`);
  return a;
}

module.exports = { getAdapter };
