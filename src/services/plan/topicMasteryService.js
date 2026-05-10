const KnowledgeProfile = require('../../models/KnowledgeProfile');
const ContentProgress = require('../../models/ContentProgress');
const ExternalContentTouch = require('../../models/ExternalContentTouch');
const InterviewSession = require('../../models/InterviewSession');
const Plan = require('../../models/Plan');

/**
 * Aggregates per-topic mastery + objective-level interview mastery for the
 * Plan tab's Topic Mastery section.
 */
async function getMasterySummary(userId) {
  const [profile, plan] = await Promise.all([
    KnowledgeProfile.findOne({ userId }).lean(),
    Plan.findOne({ userId, isActive: true }).lean(),
  ]);

  // Build display-name lookup from plan tasks (plan tasks carry topic.displayName)
  const displayByCanonical = new Map();
  if (plan?.weeklySchedule) {
    for (const week of plan.weeklySchedule) {
      for (const task of (week.tasks || [])) {
        if (task.topic?.canonicalName) {
          displayByCanonical.set(task.topic.canonicalName, task.topic.displayName);
        }
      }
    }
  }

  const topicNames = (profile?.topicMastery || []).map(t => t.topic);
  const [contentByTopic, touchesByTopic] = await Promise.all([
    contentCountsPerTopic(userId, topicNames),
    externalTouchCounts(userId, topicNames),
  ]);

  const topics = (profile?.topicMastery || []).map(t => ({
    canonicalName: t.topic,
    displayName: displayByCanonical.get(t.topic) || titleCase(t.topic),
    level: t.level || 'not_started',
    score: t.score || 0,
    quizzesTaken: t.quizzesTaken || 0,
    contentConsumed: contentByTopic[t.topic] || 0,
    externalTouches: touchesByTopic[t.topic] || 0,
    lastAssessedAt: t.lastAssessedAt || null,
    scoreHistory: (t.scoreHistory || []).slice(-10).map(s => ({ score: s.score, date: s.date })),
    trend: t.trend || 'stable',
  }));

  // Objective-level interview rollup
  const interviewSessions = await InterviewSession.find({
    userId,
    status: { $in: ['completed', 'evaluated'] },
  }).sort({ completedAt: -1 }).limit(20).lean();

  const totalSessions = interviewSessions.length;
  const overallScores = interviewSessions
    .map(s => s.evaluation?.overallScore)
    .filter(s => typeof s === 'number');
  const averageScore = overallScores.length > 0
    ? Math.round((overallScores.reduce((a, b) => a + b, 0) / overallScores.length) * 10) / 10
    : 0;
  const recentScoresChrono = overallScores.slice(0, 6).reverse();
  const interviewTrend = computeTrendFromScores(recentScoresChrono);

  // Per-topic interview rollup from KnowledgeProfile.topicInterviewMastery
  const perTopic = [];
  const mastery = profile?.topicInterviewMastery;
  if (mastery) {
    const entries = mastery instanceof Map ? Array.from(mastery.entries()) : Object.entries(mastery);
    for (const [topic, m] of entries) {
      perTopic.push({
        topic,
        displayName: displayByCanonical.get(topic) || titleCase(topic),
        score: (m && typeof m.score === 'number') ? m.score : 0,
        sessions: (m && m.sessions) || 0,
        trend: (m && m.trend) || 'stable',
      });
    }
    perTopic.sort((a, b) => b.sessions - a.sessions);
  }

  return {
    topics,
    interview: { totalSessions, averageScore, trend: interviewTrend, perTopic },
  };
}

async function contentCountsPerTopic(userId, topicNames) {
  if (!topicNames.length) return {};
  const progresses = await ContentProgress.find({ userId, isCompleted: true })
    .populate('contentId', 'topics')
    .lean();
  const counts = {};
  for (const t of topicNames) counts[t] = 0;
  for (const p of progresses) {
    const topics = p.contentId?.topics || [];
    for (const t of topics) {
      if (counts[t] !== undefined) counts[t]++;
    }
  }
  return counts;
}

async function externalTouchCounts(userId, topicNames) {
  if (!topicNames.length) return {};
  const counts = {};
  for (const t of topicNames) counts[t] = 0;
  const touches = await ExternalContentTouch.find({
    userId,
    topicCanonicalName: { $in: topicNames },
  }).select('topicCanonicalName').lean();
  for (const t of touches) {
    if (counts[t.topicCanonicalName] !== undefined) counts[t.topicCanonicalName]++;
  }
  return counts;
}

function titleCase(canonical) {
  return String(canonical || '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function computeTrendFromScores(scores) {
  if (!scores || scores.length < 3) return 'stable';
  const recent = scores.slice(-3);
  const earlier = scores.slice(-6, -3);
  if (earlier.length === 0) return 'stable';
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const earlierAvg = earlier.reduce((a, b) => a + b, 0) / earlier.length;
  if (recentAvg - earlierAvg > 5) return 'improving';
  if (earlierAvg - recentAvg > 5) return 'declining';
  return 'stable';
}

module.exports = { getMasterySummary, _internal: { computeTrendFromScores, titleCase } };
