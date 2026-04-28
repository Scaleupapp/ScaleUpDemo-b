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

module.exports = {
  startAttempt,
  _internal: { _decideFlowType },
};
