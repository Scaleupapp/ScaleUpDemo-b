/**
 * v2 "You" Tab Overview route.
 *
 *   GET /api/v2/you/overview
 *
 * Aggregates everything the v2 "You" screen needs in one network call:
 *   - user profile (name, avatar, initial)
 *   - readiness score for primary objective
 *   - target date + weeks remaining
 *   - week progress (3 of 7 done)
 *   - streak (quiet stat)
 *   - top gap (one topic name + CTA)
 *   - time invested
 *   - role flags (isCreator, isAdmin)
 */
const express = require('express');
const auth = require('../../middleware/auth');
const User = require('../../models/User');
const UserObjective = require('../../models/UserObjective');
const Plan = require('../../models/Plan');
const KnowledgeProfile = require('../../models/KnowledgeProfile');
const CompetitionProfile = require('../../models/CompetitionProfile');
const Journey = require('../../models/Journey');

const router = express.Router();

router.get('/overview', auth, async (req, res) => {
  try {
    const userId = req.user.userId;

    const [user, objective, plan, journey, knowledge, competition] = await Promise.all([
      User.findById(userId).select('firstName lastName profilePicture role').lean(),
      UserObjective.findOne({ userId, status: 'active', isPrimary: true }).lean(),
      Plan.findOne({ userId, status: { $in: ['active', 'ready'] } }).lean(),
      Journey.findOne({ userId, status: 'active' }).lean(),
      KnowledgeProfile.findOne({ userId }).lean(),
      CompetitionProfile.findOne({ userId }).lean(),
    ]);

    // Readiness
    const readiness =
      plan?.readinessScore ??
      journey?.readinessScore ??
      computeReadinessFromKnowledge(knowledge) ??
      0;

    // Target date and weeks remaining
    let targetDateStr = null;
    let weeksRemaining = null;
    if (objective?.targetDate) {
      const target = new Date(objective.targetDate);
      const now = new Date();
      const days = Math.max(0, Math.ceil((target - now) / (1000 * 60 * 60 * 24)));
      weeksRemaining = Math.ceil(days / 7);
      targetDateStr = target.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    }

    // Week progress
    const currentWeek = plan?.currentWeek || journey?.currentWeek || 1;
    const tasksThisWeek = (plan?.tasks || []).filter(t => t.weekNumber === currentWeek);
    const weekDone = tasksThisWeek.filter(t => t.completedAt).length;
    const weekTotal = tasksThisWeek.length;

    // Top gap
    const topGap = pickTopGap(knowledge);

    // Time invested (best-effort — sum of plan.tasks.completedAt durations)
    const hoursInvested = Math.round((plan?.tasks || []).reduce((sum, t) => {
      if (!t.completedAt) return sum;
      return sum + (t.actualDurationMin || t.durationMin || t.estimatedMinutes || 0);
    }, 0) / 60);

    const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim();

    return res.json({
      success: true,
      data: {
        user: {
          name: fullName || 'Learner',
          firstName: user?.firstName || 'Learner',
          initial: (user?.firstName?.[0] || 'L').toUpperCase(),
          avatarURL: user?.profilePicture || null,
          role: user?.role || 'consumer',
        },
        readiness: {
          score: readiness,
          onTrackText: readiness >= 70 ? `On track for ${targetDateStr || 'your target'}` : `${readiness}% ready`,
          targetDate: targetDateStr,
          weeksRemaining,
        },
        weekProgress: weekTotal > 0
          ? { done: weekDone, total: weekTotal, week: currentWeek }
          : null,
        streak: {
          current: competition?.currentStreak || 0,
          longest: competition?.longestStreak || 0,
        },
        topGap: topGap ? {
          topic: topGap.topic,
          masteryPct: topGap.mastery,
          ctaLabel: 'Fix this',
        } : null,
        timeInvested: { hours: hoursInvested },
        flags: {
          isCreator: ['creator', 'contributor', 'admin'].includes(user?.role),
          isAdmin: user?.role === 'admin',
        },
        objectiveLabel: buildObjectiveLabel(objective),
      },
    });
  } catch (err) {
    console.error('[v2/you/overview] error', err);
    return res.status(500).json({ success: false, message: 'Failed to load overview' });
  }
});

function computeReadinessFromKnowledge(knowledge) {
  if (!knowledge?.topicProfiles) return null;
  const entries = Object.values(knowledge.topicProfiles || {});
  if (entries.length === 0) return null;
  const avg = entries.reduce((s, t) => s + (t.masteryLevel || 0), 0) / entries.length;
  return Math.round(avg);
}

function pickTopGap(knowledge) {
  if (!knowledge?.topicProfiles) return null;
  const entries = Object.entries(knowledge.topicProfiles || {})
    .map(([topic, t]) => ({ topic, mastery: t.masteryLevel || 0 }))
    .filter(t => t.mastery < 70)
    .sort((a, b) => a.mastery - b.mastery);
  return entries[0] || null;
}

function buildObjectiveLabel(obj) {
  if (!obj) return null;
  const s = obj.specifics || {};
  const parts = [];
  if (s.targetRole) parts.push(s.targetRole);
  if (s.targetCompany) parts.push(`@ ${s.targetCompany}`);
  if (s.examName) parts.push(s.examName);
  if (s.targetSkill && parts.length === 0) parts.push(s.targetSkill);

  const timelineLabel = {
    '1_month': '1mo', '3_months': '3mo', '6_months': '6mo',
    '1_year': '12mo', 'no_deadline': '',
  }[obj.timeline] || '';

  const base = parts.join(' ') || obj.objectiveType.replace(/_/g, ' ');
  return timelineLabel ? `${base} · ${timelineLabel}` : base;
}

module.exports = router;
