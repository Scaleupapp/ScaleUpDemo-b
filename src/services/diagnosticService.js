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
const DiagnosticAttempt = require('../models/DiagnosticAttempt');
const KnowledgeProfile = require('../models/KnowledgeProfile');
const ConceptMastery = require('../models/ConceptMastery');
const UserObjective = require('../models/UserObjective');
const diagnosticPoolService = require('./diagnosticPoolService');
const DiagnosticQuestionBank = require('../models/DiagnosticQuestionBank');
const selector = require('./diagnosticSelectorService');

const RATING_TO_NUM = { novice: 0, familiar: 1, proficient: 2, expert: 3, unsure: 0 };

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
  telemetry.logEvent('diagnostic.started', { userId: String(userId), flowType });

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

async function finishAttempt(attemptId) {
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

  attempt.status = 'completed';
  attempt.completedAt = new Date();
  await attempt.save();

  // Apply to KnowledgeProfile
  await _applyToKnowledgeProfile(attempt).catch(err =>
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
  const obj = {};
  for (const [k, v] of attempt.results.entries()) obj[k] = v;
  return { results: obj, status: attempt.status };
}

async function _applyToKnowledgeProfile(attempt) {
  const kp = await KnowledgeProfile.findOne({ userId: attempt.userId });
  if (!kp) return;
  const now = new Date();
  for (const [comp, res] of attempt.results.entries()) {
    let entry = kp.topicMastery.find(t => t.topic === comp);
    if (!entry) {
      entry = { topic: comp, scoreHistory: [] };
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

module.exports = {
  startAttempt,
  submitSelfRating,
  nextQuestion,
  submitAnswer,
  finishAttempt,
  abandon,
  _internal: { _decideFlowType },
};
