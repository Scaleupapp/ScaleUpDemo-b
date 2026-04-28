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
const DiagnosticAttempt = require('../models/DiagnosticAttempt');
const KnowledgeProfile = require('../models/KnowledgeProfile');
const UserObjective = require('../models/UserObjective');
const diagnosticPoolService = require('./diagnosticPoolService');
const DiagnosticQuestionBank = require('../models/DiagnosticQuestionBank');
const selector = require('./diagnosticSelectorService');

/**
 * Decide flow type based on whether the user has any prior platform activity.
 * Threshold: any completed quiz attempt → existing-user flow.
 */
function _decideFlowType(profile) {
  if (profile && (profile.totalQuizzesTaken || 0) >= 1) return 'existing_user_tune';
  return 'new_user';
}

async function startAttempt(userId) {
  const [profile, objective] = await Promise.all([
    KnowledgeProfile.findOne({ userId }),
    UserObjective.findOne({ userId, status: 'active', isPrimary: true }).lean(),
  ]);

  const competencies = objective?.analysis?.competencies || [];
  if (!competencies.length) return null; // caller routes to fallback (Edge 7)

  const flowType = _decideFlowType(profile);

  const attempt = new DiagnosticAttempt({
    userId,
    flowType,
    status: 'in_progress',
    startedAt: new Date(),
  });
  await attempt.save();

  return {
    attemptId: attempt._id,
    flowType,
    competenciesToAssess: competencies.map(c => ({ name: c.name })),
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
    objective: attempt.objectiveLabel || null,
  });
  attempt.poolQuestionIds = pool.map(q => q._id).filter(Boolean);
  await attempt.save();
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

async function nextQuestion(attemptId) {
  const attempt = await DiagnosticAttempt.findById(attemptId);
  if (!attempt) throw new Error('attempt not found');

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

    // Find a pool question matching (competency, difficulty), not already used
    const usedIds = new Set(attempt.answers.map(a => String(a.questionId)));
    for (const qid of attempt.poolQuestionIds) {
      if (usedIds.has(String(qid))) continue;
      const q = await DiagnosticQuestionBank.findById(qid);
      if (!q) continue;
      if (q.difficulty !== decision.nextDifficulty) continue;
      // We don't strictly require q.canonicalCompetency === comp — pool may have other competencies; keep moving if mismatch
      if (q.canonicalCompetency && q.canonicalCompetency !== comp) continue;
      return {
        done: false,
        question: {
          id: q._id, competency: comp, difficulty: q.difficulty,
          questionText: q.questionText, options: q.options,
        },
      };
    }
    // No matching question in pool — try any difficulty for this competency
    for (const qid of attempt.poolQuestionIds) {
      if (usedIds.has(String(qid))) continue;
      const q = await DiagnosticQuestionBank.findById(qid);
      if (q && q.canonicalCompetency === comp) {
        return {
          done: false,
          question: {
            id: q._id, competency: comp, difficulty: q.difficulty,
            questionText: q.questionText, options: q.options,
          },
        };
      }
    }
  }
  return { done: true };
}

async function submitAnswer(attemptId, questionId, selectedAnswer, timeTaken) {
  const attempt = await DiagnosticAttempt.findById(attemptId);
  if (!attempt) throw new Error('attempt not found');
  const q = await DiagnosticQuestionBank.findById(questionId);
  if (!q) throw new Error('question not found');

  const isCorrect = q.correctAnswer === selectedAnswer;
  attempt.answers.push({
    questionId,
    competency: q.canonicalCompetency,
    difficulty: q.difficulty,
    selectedAnswer,
    isCorrect,
    timeTaken: timeTaken || 0,
  });
  await attempt.save();
  return { ack: true };
}

module.exports = {
  startAttempt,
  submitSelfRating,
  nextQuestion,
  submitAnswer,
  _internal: { _decideFlowType },
};
