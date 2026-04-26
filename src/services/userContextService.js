/**
 * User Context Service — BUG-8 Phase 8
 *
 * Single aggregator that gives any feature a unified picture of what
 * the system knows about a user. Pulls from Phases 1-7:
 *   - KnowledgeProfile (topic mastery + strengths/weaknesses)
 *   - Recent QuizAttempts (last 10 — what they just struggled with)
 *   - MisconceptionLedger (top recurring misconceptions)
 *   - ConceptMastery / Spaced Repetition (concepts due for review)
 *   - CognitiveProfile (high-confidence behavioural traits)
 *   - UserObjective (active goal)
 *   - Recent AI Tutor conversations (last 3 — what they've been asking)
 *
 * Public API:
 *   getUserContext(userId, opts?)
 *     Returns a compact, JSON-serialisable digest. Used by:
 *       - aiTutorService to seed conversations with relevant context
 *       - progressInsightsService (Phase 2 LLM layer can include this
 *         in the digest to make narrative even more grounded)
 *
 * Cached for 5 minutes per user. Cache invalidates whenever any source
 * collection updates significantly (caller's responsibility — for now
 * we just rely on the short TTL).
 */

const KnowledgeProfile = require('../models/KnowledgeProfile');
const QuizAttempt = require('../models/QuizAttempt');
const UserObjective = require('../models/UserObjective');
const Conversation = require('../models/Conversation');
const misconceptionService = require('./misconceptionService');
const spacedRepetitionService = require('./spacedRepetitionService');
const cognitiveFingerprintService = require('./cognitiveFingerprintService');

const CACHE_TTL_MS = 5 * 60 * 1000;
const _cache = new Map(); // userId -> { value, expiresAt }

function _getCached(userId) {
  const entry = _cache.get(userId);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.value;
}
function _setCached(userId, value) {
  _cache.set(userId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}
function invalidate(userId) { _cache.delete(userId); }

/**
 * Returns a compact context object — designed to be small enough to
 * include in an LLM prompt, but rich enough to make the consumer feel
 * the system knows the user.
 */
async function getUserContext(userId, { refresh = false } = {}) {
  if (!refresh) {
    const cached = _getCached(userId);
    if (cached) return cached;
  }

  const [
    profile, recentAttempts, objective, misconceptions, dueConcepts, cognitiveTraits, recentConversations,
  ] = await Promise.all([
    KnowledgeProfile.findOne({ userId }).lean().catch(() => null),
    QuizAttempt.find({ userId, completedAt: { $exists: true } })
      .sort({ completedAt: -1 }).limit(10)
      .select('topicBreakdown score completedAt')
      .lean().catch(() => []),
    UserObjective.findOne({ userId, status: 'active', isPrimary: true }).lean().catch(() => null),
    misconceptionService.getRecurringPatterns(userId, 3).catch(() => []),
    spacedRepetitionService.getDueConcepts(userId, { limit: 5 }).catch(() => []),
    cognitiveFingerprintService.getHighConfidenceTraits(userId).catch(() => []),
    Conversation.find({ userId })
      .sort({ updatedAt: -1 }).limit(3)
      .select('contentTitle contentDomain messageCount updatedAt messages')
      .lean().catch(() => []),
  ]);

  // Derive lightweight summaries
  const weakTopics = (profile?.topicMastery || [])
    .filter(t => (t.score || 0) < 60 && (t.quizzesTaken || 0) >= 1)
    .sort((a, b) => (a.score || 0) - (b.score || 0))
    .slice(0, 5)
    .map(t => ({ topic: t.topic, score: t.score, lastAssessedAt: t.lastAssessedAt }));

  const strongTopics = (profile?.topicMastery || [])
    .filter(t => (t.score || 0) >= 75)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 3)
    .map(t => ({ topic: t.topic, score: t.score }));

  const recentTopicsTouched = [...new Set(
    recentAttempts.flatMap(a => (a.topicBreakdown || []).map(b => b.topic)).filter(Boolean)
  )].slice(0, 5);

  const recentTutorTopics = recentConversations
    .map(c => c.contentTitle)
    .filter(Boolean)
    .slice(0, 3);

  const lastTutorOpenQuestions = [];
  for (const conv of recentConversations) {
    const lastUserMsg = (conv.messages || [])
      .filter(m => m.role === 'user')
      .slice(-1)[0];
    if (lastUserMsg?.content) {
      const trimmed = lastUserMsg.content.length > 140
        ? lastUserMsg.content.slice(0, 140) + '...'
        : lastUserMsg.content;
      lastTutorOpenQuestions.push({
        contentTitle: conv.contentTitle, question: trimmed,
        askedAt: lastUserMsg.timestamp || conv.updatedAt,
      });
    }
  }

  const context = {
    userId: String(userId),
    profile: profile ? {
      overallScore: profile.overallScore ?? 0,
      totalQuizzesTaken: profile.totalQuizzesTaken ?? 0,
      totalTopicsCovered: profile.totalTopicsCovered ?? 0,
      lastUpdatedAt: profile.lastUpdatedAt,
    } : null,
    weakTopics,
    strongTopics,
    recentTopicsTouched,
    objective: objective ? {
      type: objective.objectiveType,
      label: objective.specifics?.targetRole || objective.specifics?.examName || objective.specifics?.targetSkill || objective.objectiveType,
      targetDate: objective.targetDate,
      timeline: objective.timeline,
    } : null,
    misconceptions: misconceptions.map(m => ({ tag: m.tag, count: m.count, explanation: m.explanation, topics: m.topicsAffected })),
    dueForReview: dueConcepts.map(d => ({ concept: d.concept, daysOverdue: Math.round(d.daysOverdue) })),
    cognitiveTraits: cognitiveTraits.map(c => ({
      kind: c.kind,
      ...(c.kind === 'time_of_day' ? { bestHourBlock: c.bestHourBlock, lift: c.bestHourScoreLift } : {}),
      ...(c.kind === 'modality' ? { preferred: c.preferred } : {}),
      ...(c.kind === 'session_rhythm' ? { style: c.style, medianMinutes: c.medianSessionMinutes } : {}),
    })),
    recentAITutor: {
      topicsCovered: recentTutorTopics,
      openQuestions: lastTutorOpenQuestions,
    },
    generatedAt: new Date().toISOString(),
  };

  _setCached(userId, context);
  return context;
}

/**
 * Compact one-line natural-language summary of the user context — useful
 * to drop into other LLM prompts as a single system message.
 *
 * Example output:
 *   "User: working toward Senior PM. Weak: prioritization (45%), roadmapping (52%).
 *    Recently struggled with: gradient descent. Asked about momentum yesterday."
 */
function summarize(context) {
  if (!context) return '';
  const parts = [];
  if (context.objective?.label) parts.push(`working toward ${context.objective.label}`);
  if (context.weakTopics?.length) {
    const w = context.weakTopics.slice(0, 2).map(t => `${t.topic} (${t.score}%)`).join(', ');
    parts.push(`weak in ${w}`);
  }
  if (context.dueForReview?.length) {
    const d = context.dueForReview.slice(0, 2).map(d => d.concept).join(', ');
    parts.push(`overdue for review on ${d}`);
  }
  if (context.misconceptions?.length) {
    parts.push(`recurring confusion: ${context.misconceptions[0].tag}`);
  }
  if (context.recentAITutor?.topicsCovered?.length) {
    parts.push(`recent tutor topics: ${context.recentAITutor.topicsCovered.slice(0, 2).join(', ')}`);
  }
  return parts.length ? `User context: ${parts.join('; ')}.` : '';
}

module.exports = {
  getUserContext,
  summarize,
  invalidate,
};
