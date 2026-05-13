/**
 * v2 Plan routes.
 *
 *   GET /api/v2/plan/today — one-hero recommendation + 3 alternatives + trajectory snapshot
 *
 * Reads from v1 Plan (weeklySchedule[].tasks[]) — does NOT replace v1 plan routes.
 */
const express = require('express');
const auth = require('../../middleware/auth');
const UserObjective = require('../../models/UserObjective');
const Plan = require('../../models/Plan');
const KnowledgeProfile = require('../../models/KnowledgeProfile');
const { forecastTrajectory } = require('../../services/v2/trajectoryService');
const { predictTaskImpact } = require('../../services/v2/predictedImpactService');

const router = express.Router();

// v1 Plan task `type` → v2 UI taskType + icon
const TASK_TYPE_MAP = {
  in_app_content: { uiType: 'watch',           icon: '📺' },
  quiz:           { uiType: 'quiz',            icon: '🧠' },
  ai_interview:   { uiType: 'interview',       icon: '🎙️' },
  external_link:  { uiType: 'external',        icon: '🔗' },
  competition:    { uiType: 'compete',         icon: '🏆' },
  manual:         { uiType: 'reflection',      icon: '💭' },
};

// v1 task type → predictedImpact taskType
const IMPACT_TYPE_MAP = {
  in_app_content: 'watch',
  quiz:           'quiz',
  ai_interview:   'interview',
  external_link:  'read',
  competition:    'quiz',
  manual:         'reflection',
};

/**
 * GET /api/v2/plan/today
 *
 * Shape (success):
 *   {
 *     greeting, statusLine, objectiveLabel,
 *     trajectory: { today, in30Days, atTargetDate, ... },
 *     weekProgress: { done, total, week, totalWeeks },
 *     hero: {
 *       taskId, taskType, icon, title, subtitle, durationMin, difficulty, primaryTopic,
 *       payload: { contentId? quizId? interviewId? url? },  // routes iOS to v1 detail screen
 *       impact: { expectedFrom, expectedTo, expectedGain, whyText }
 *     },
 *     alternatives: [ { ...same shape, smaller } ]
 *   }
 *
 * Fallbacks: no_objective | plan_brewing | day_done
 */
router.get('/today', auth, async (req, res) => {
  try {
    const userId = req.user.userId;

    const [user, objective, plan, knowledge] = await Promise.all([
      require('../../models/User').findById(userId).select('firstName').lean(),
      UserObjective.findOne({ userId, status: 'active', isPrimary: true }).lean(),
      Plan.findOne({ userId, isActive: true }).lean(),
      KnowledgeProfile.findOne({ userId }).lean(),
    ]);

    const greeting = user?.firstName ? `Hi, ${user.firstName}.` : 'Hi.';
    const objectiveLabel = buildObjectiveLabel(objective);

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

    // Current readiness — pull from knowledge profile if available
    const currentReadiness = computeReadinessFromKnowledge(knowledge) ?? 30;

    const trajectory = forecastTrajectory({
      currentReadiness,
      objectiveType: objective.objectiveType,
      specifics: objective.specifics || {},
      timeline: objective.timeline,
      currentLevel: objective.currentLevel,
    });

    // No plan yet — brewing fallback
    if (!plan || !Array.isArray(plan.weeklySchedule) || plan.weeklySchedule.length === 0) {
      return res.json({
        success: true,
        data: {
          greeting,
          objectiveLabel,
          statusLine: 'Your plan is being personalized. Meanwhile, here’s content relevant to your goal.',
          trajectory,
          fallback: 'plan_brewing',
          weekProgress: null,
        },
      });
    }

    // Find current week from earliest week with any incomplete tasks
    const currentWeekEntry =
      plan.weeklySchedule.find(w => w.tasks.some(t => t.progress?.status !== 'complete')) ||
      plan.weeklySchedule[0];

    const currentWeek = currentWeekEntry.week;
    const totalWeeks = plan.weeklySchedule.length;
    const tasksThisWeek = currentWeekEntry.tasks || [];
    const incompleteThisWeek = tasksThisWeek.filter(t => t.progress?.status !== 'complete');
    const doneThisWeek = tasksThisWeek.length - incompleteThisWeek.length;
    const weeksRemaining = Math.max(0, totalWeeks - currentWeek);

    const statusLine = trajectory.onTrack
      ? `You're on track. ${currentReadiness}% ready, ${weeksRemaining} weeks to go.`
      : `Behind pace. ${currentReadiness}% ready, ${weeksRemaining} weeks left — let’s tighten up.`;

    if (incompleteThisWeek.length === 0) {
      return res.json({
        success: true,
        data: {
          greeting,
          objectiveLabel,
          statusLine,
          trajectory,
          weekProgress: { done: doneThisWeek, total: tasksThisWeek.length, week: currentWeek, totalWeeks },
          fallback: 'day_done',
          message: 'You’ve completed everything we recommended today. See you tomorrow.',
        },
      });
    }

    // Rank by lowest current mastery on the task's primary topic
    const topicMasteryFor = (canonicalName) => {
      const tp = knowledge?.topicProfiles?.[canonicalName];
      return tp?.masteryLevel ?? 0;
    };

    const ranked = [...incompleteThisWeek].sort(
      (a, b) => topicMasteryFor(a.topic?.canonicalName) - topicMasteryFor(b.topic?.canonicalName)
    );

    const hero = shapeHero(ranked[0], topicMasteryFor);
    const alternatives = ranked.slice(1, 4).map(t => shapeAlt(t));

    return res.json({
      success: true,
      data: {
        greeting,
        objectiveLabel,
        statusLine,
        trajectory,
        weekProgress: { done: doneThisWeek, total: tasksThisWeek.length, week: currentWeek, totalWeeks },
        hero,
        alternatives,
      },
    });
  } catch (err) {
    console.error('[v2/plan/today] error', err);
    return res.status(500).json({ success: false, message: 'Failed to load today’s plan' });
  }
});

// ──────────────────────────────────────────────
// Shaping helpers
// ──────────────────────────────────────────────

function shapeHero(task, topicMasteryFor) {
  const map = TASK_TYPE_MAP[task.type] || { uiType: 'manual', icon: '✨' };
  const impactType = IMPACT_TYPE_MAP[task.type] || 'watch';
  const primaryTopicKey = task.topic?.canonicalName;
  const currentMastery = topicMasteryFor(primaryTopicKey);

  // Prefer the baked-in impact (computed at plan generation time). Fall back
  // to on-the-fly computation for legacy plans that don't have one.
  const impact = task.payload?.impact || predictTaskImpact({
    taskType: impactType,
    primaryTopic: task.topic?.displayName || 'this topic',
    currentMastery,
    difficulty: task.payload?.difficulty || 3,
  });

  return {
    taskId: String(task._id),
    taskType: map.uiType,
    icon: map.icon,
    title: task.payload?.title || task.topic?.displayName || 'Today’s task',
    subtitle: task.payload?.creator || task.payload?.source || '',
    durationMin: task.payload?.estimatedMinutes || 20,
    difficulty: (task.payload?.difficulty || 3) >= 4 ? 'hard'
              : (task.payload?.difficulty || 3) <= 2 ? 'easy' : 'medium',
    primaryTopic: task.topic?.displayName || primaryTopicKey,
    payload: extractPayload(task),
    impact,
  };
}

function shapeAlt(task) {
  const map = TASK_TYPE_MAP[task.type] || { uiType: 'manual', icon: '✨' };
  return {
    taskId: String(task._id),
    taskType: map.uiType,
    icon: map.icon,
    title: task.payload?.title || task.topic?.displayName || 'Task',
    durationMin: task.payload?.estimatedMinutes || 10,
    primaryTopic: task.topic?.displayName,
    payload: extractPayload(task),
    reason: task.payload?.reason || 'Plan-aligned',
  };
}

/**
 * Pull out just the routing fields iOS/Android need to open the right detail screen.
 */
function extractPayload(task) {
  const p = task.payload || {};
  return {
    contentId: p.contentId || null,
    quizId:    p.quizId    || null,
    interviewId: p.interviewId || p.scenarioId || null,
    url:       p.url       || null,
  };
}

function computeReadinessFromKnowledge(knowledge) {
  if (!knowledge?.topicProfiles) return null;
  const entries = Object.values(knowledge.topicProfiles || {});
  if (entries.length === 0) return null;
  const avg = entries.reduce((s, t) => s + (t.masteryLevel || 0), 0) / entries.length;
  return Math.round(avg);
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
