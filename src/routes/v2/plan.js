/**
 * v2 Plan routes.
 *
 * Adds:
 *   GET /api/v2/plan/today — one-hero recommendation + 3 alternatives + trajectory snapshot
 *
 * The one-hero shape is what powers the redesigned v2 Home screen.
 * Reads from v1 plan data — does NOT replace v1 plan routes.
 */
const express = require('express');
const auth = require('../../middleware/auth');
const UserObjective = require('../../models/UserObjective');
const Plan = require('../../models/Plan');
const KnowledgeProfile = require('../../models/KnowledgeProfile');
const { forecastTrajectory } = require('../../services/v2/trajectoryService');
const { predictTaskImpact } = require('../../services/v2/predictedImpactService');

const router = express.Router();

/**
 * GET /api/v2/plan/today
 *
 * Returns:
 *   {
 *     greeting: "Hi, Nirpeksh.",
 *     statusLine: "You're on track for August. 74% ready, 11 weeks to go.",
 *     trajectory: { today, in30Days, atTargetDate, ... },
 *     weekProgress: { done: 3, total: 7, week: 11, totalWeeks: 24 },
 *     hero: {
 *       taskId, taskType: 'watch', icon: '📺',
 *       title: 'Dynamic Programming — Memoization',
 *       subtitle: 'with Striver',
 *       durationMin: 22,
 *       difficulty: 'hard',
 *       primaryTopic: 'dp',
 *       impact: { expectedFrom, expectedTo, expectedGain, whyText }
 *     },
 *     alternatives: [
 *       { taskId, taskType, icon, title, durationMin, primaryTopic, reason },
 *       ...
 *     ]
 *   }
 *
 * If no plan exists yet, returns a fallback shape with diagnostic CTA.
 */
router.get('/today', auth, async (req, res) => {
  try {
    const userId = req.user.userId;

    const [user, objective, plan, knowledge] = await Promise.all([
      require('../../models/User').findById(userId).select('firstName').lean(),
      UserObjective.findOne({ userId, status: 'active', isPrimary: true }).lean(),
      Plan.findOne({ userId, status: { $in: ['active', 'ready'] } }).lean(),
      KnowledgeProfile.findOne({ userId }).lean(),
    ]);

    const greeting = user?.firstName ? `Hi, ${user.firstName}.` : 'Hi.';

    // No objective yet — pre-onboarding fallback
    if (!objective) {
      return res.json({
        success: true,
        data: {
          greeting,
          statusLine: 'Let’s set you up — about 10 minutes.',
          fallback: 'no_objective',
          cta: { label: 'Start diagnostic', deeplink: 'scaleup://onboarding' },
        },
      });
    }

    // Compute current readiness — pull from plan or recompute from knowledge profile
    const currentReadiness =
      plan?.readinessScore ??
      Math.round(
        (knowledge?.topicProfiles
          ? Array.from(knowledge.topicProfiles.values?.() || []).reduce((s, t) => s + (t.masteryLevel || 0), 0) /
            Math.max(1, knowledge.topicProfiles.size || 1)
          : 30)
      );

    const trajectory = forecastTrajectory({
      currentReadiness,
      objectiveType: objective.objectiveType,
      specifics: objective.specifics || {},
      timeline: objective.timeline,
      currentLevel: objective.currentLevel,
    });

    const weeksLeft = Math.max(0, trajectory.timelineWeeks - (plan?.currentWeek || 0));
    const statusLine = trajectory.onTrack
      ? `You're on track. ${currentReadiness}% ready, ${weeksLeft} weeks to go.`
      : `Behind pace. ${currentReadiness}% ready, ${weeksLeft} weeks left — let’s tighten up.`;

    // Plan not yet generated — show "plan brewing" alongside content-ready fallback
    if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
      return res.json({
        success: true,
        data: {
          greeting,
          statusLine: 'Your plan is being personalized. Meanwhile, here’s relevant content.',
          trajectory,
          fallback: 'plan_brewing',
          weekProgress: null,
        },
      });
    }

    // Find today's tasks — first incomplete, ranked
    const today = new Date();
    const todaysTasks = plan.tasks.filter(t =>
      !t.completedAt && (!t.scheduledFor || new Date(t.scheduledFor) <= today)
    );

    if (todaysTasks.length === 0) {
      return res.json({
        success: true,
        data: {
          greeting,
          statusLine,
          trajectory,
          fallback: 'day_done',
          message: 'You’ve completed everything we recommended today. See you tomorrow.',
        },
      });
    }

    // Take top hero — highest leverage = lowest current mastery on primary topic
    const topicMastery = (topic) => {
      const tp = knowledge?.topicProfiles?.[topic];
      return tp?.masteryLevel ?? 0;
    };

    const ranked = [...todaysTasks].sort((a, b) => topicMastery(a.primaryTopic) - topicMastery(b.primaryTopic));
    const heroTask = ranked[0];
    const alternatives = ranked.slice(1, 4);

    const heroImpact = predictTaskImpact({
      taskType: heroTask.taskType,
      primaryTopic: heroTask.primaryTopic || 'this topic',
      currentMastery: topicMastery(heroTask.primaryTopic),
      difficulty: heroTask.difficulty || 3,
    });

    const completedThisWeek = plan.tasks.filter(t =>
      t.weekNumber === (plan.currentWeek || 1) && t.completedAt
    ).length;
    const totalThisWeek = plan.tasks.filter(t => t.weekNumber === (plan.currentWeek || 1)).length;

    return res.json({
      success: true,
      data: {
        greeting,
        statusLine,
        trajectory,
        weekProgress: {
          done: completedThisWeek,
          total: totalThisWeek,
          week: plan.currentWeek || 1,
          totalWeeks: plan.totalWeeks || trajectory.timelineWeeks,
        },
        hero: {
          taskId: heroTask._id || heroTask.id,
          taskType: heroTask.taskType,
          icon: iconForTaskType(heroTask.taskType),
          title: heroTask.title,
          subtitle: heroTask.subtitle || heroTask.creatorName || '',
          durationMin: heroTask.durationMin || heroTask.estimatedMinutes || 20,
          difficulty: heroTask.difficulty === 5 ? 'hard' : heroTask.difficulty <= 2 ? 'easy' : 'medium',
          primaryTopic: heroTask.primaryTopic,
          impact: heroImpact,
        },
        alternatives: alternatives.map(t => ({
          taskId: t._id || t.id,
          taskType: t.taskType,
          icon: iconForTaskType(t.taskType),
          title: t.title,
          durationMin: t.durationMin || t.estimatedMinutes || 10,
          primaryTopic: t.primaryTopic,
          reason: t.recommendationReason || 'Plan-aligned',
        })),
      },
    });
  } catch (err) {
    console.error('[v2/plan/today] error', err);
    return res.status(500).json({ success: false, message: 'Failed to load today’s plan' });
  }
});

function iconForTaskType(t) {
  return ({
    watch: '📺',
    listen: '🎧',
    read: '📖',
    quiz: '🧠',
    interview: '🎙️',
    mock_exam: '📝',
    notes_create: '📝',
    reflection: '💭',
    conversation: '💬',
    coding_practice: '📐',
  })[t] || '✨';
}

module.exports = router;
