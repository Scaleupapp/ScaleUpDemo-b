/**
 * v2 Plan routes.
 *
 *   GET  /api/v2/plan/today    — one-hero recommendation + alternatives + trajectory
 *   POST /api/v2/plan/generate — trigger plan generation AFTER the Reality Check
 *                                (v2 order: Diagnostic → Reality Check → Plan Creation)
 *
 * Reads from v1 Plan (weeklySchedule[].tasks[]) — does NOT replace v1 plan routes.
 */
const express = require('express');
const auth = require('../../middleware/auth');
const UserObjective = require('../../models/UserObjective');
const Plan = require('../../models/Plan');
const KnowledgeProfile = require('../../models/KnowledgeProfile');
const DiagnosticAttempt = require('../../models/DiagnosticAttempt');
const { planGenerationQueue } = require('../../config/queue');
const { forecastTrajectory } = require('../../services/v2/trajectoryService');
const { predictTaskImpact } = require('../../services/v2/predictedImpactService');

const router = express.Router();

/**
 * POST /api/v2/plan/generate
 * Body: { attemptId }
 *
 * Triggers plan generation for a v2 user, AFTER they've confirmed their weekly
 * commitment on the Reality Check screen. For v2 users the diagnostic-finish
 * leaves planGenerationStatus = 'awaiting_reality_check'; this endpoint moves
 * it to 'generating' and enqueues the job.
 *
 * Idempotent — if the plan is already generating/ready, it's a no-op success.
 */
router.post('/generate', auth, async (req, res) => {
  const { attemptId } = req.body || {};
  if (!attemptId) {
    return res.status(400).json({ success: false, message: 'attemptId is required' });
  }
  try {
    const attempt = await DiagnosticAttempt.findOne({ _id: attemptId, userId: req.user.userId });
    if (!attempt) {
      return res.status(404).json({ success: false, message: 'Diagnostic attempt not found' });
    }

    // Already moving / done — idempotent no-op.
    if (['generating', 'ready'].includes(attempt.planGenerationStatus)) {
      return res.json({ success: true, data: { status: attempt.planGenerationStatus, alreadyTriggered: true } });
    }

    await DiagnosticAttempt.updateOne(
      { _id: attempt._id },
      { $set: { planGenerationStatus: 'generating' } }
    );
    await planGenerationQueue.add(
      'generate',
      { attemptId: String(attempt._id) },
      { attempts: 2, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: 50 }
    );

    return res.json({ success: true, data: { status: 'generating', alreadyTriggered: false } });
  } catch (err) {
    console.error('[v2/plan/generate] error', err);
    return res.status(500).json({ success: false, message: 'Failed to start plan generation' });
  }
});

/**
 * GET /api/v2/plan/generation-status?attemptId=...
 * Lightweight poll for the Plan Creation screen.
 */
router.get('/generation-status', auth, async (req, res) => {
  const attemptId = req.query.attemptId;
  if (!attemptId) {
    return res.status(400).json({ success: false, message: 'attemptId is required' });
  }
  try {
    const attempt = await DiagnosticAttempt.findOne({ _id: attemptId, userId: req.user.userId })
      .select('planGenerationStatus planId').lean();
    if (!attempt) {
      return res.status(404).json({ success: false, message: 'Diagnostic attempt not found' });
    }
    return res.json({
      success: true,
      data: { status: attempt.planGenerationStatus, planId: attempt.planId || null },
    });
  } catch (err) {
    console.error('[v2/plan/generation-status] error', err);
    return res.status(500).json({ success: false, message: 'Failed to read status' });
  }
});

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

// How many tasks make up "today's structured set".
const TODAYS_TASK_COUNT = 5;

/**
 * GET /api/v2/plan/today
 *
 * Returns the STRUCTURED DAY — a set of plan-aligned tasks, not a single hero.
 *
 * Shape (success):
 *   {
 *     greeting, statusLine, objectiveLabel,
 *     trajectory: { today, in30Days, atTargetDate, ... },
 *     weekProgress: { done, total, week, totalWeeks },
 *     todaysTasks: [ {
 *       taskId, taskType, icon, title, subtitle, durationMin, difficulty,
 *       primaryTopic, reason,
 *       payload: { contentId? quizId? interviewId? url? },
 *       impact: { expectedFrom, expectedTo, expectedGain, whyText }
 *     } ],
 *     totalDurationMin,         // sum across todaysTasks
 *     hasMoreThisWeek: Bool,    // are there incomplete tasks beyond today's set?
 *     skippedCount: Int         // skipped tasks in the current week (for Reshuffle affordance)
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
    // "available" = not completed and not skipped — these are eligible for today's set
    const availableThisWeek = tasksThisWeek.filter(
      t => t.progress?.status !== 'complete' && t.progress?.status !== 'skipped'
    );
    const doneThisWeek = tasksThisWeek.filter(t => t.progress?.status === 'complete').length;
    const skippedCount = tasksThisWeek.filter(t => t.progress?.status === 'skipped').length;
    const weeksRemaining = Math.max(0, totalWeeks - currentWeek);

    const statusLine = trajectory.onTrack
      ? `You're on track. ${currentReadiness}% ready, ${weeksRemaining} weeks to go.`
      : `Behind pace. ${currentReadiness}% ready, ${weeksRemaining} weeks left — let’s tighten up.`;

    if (availableThisWeek.length === 0) {
      // Either everything's done, or everything left is skipped — offer Reshuffle.
      return res.json({
        success: true,
        data: {
          greeting,
          objectiveLabel,
          statusLine,
          trajectory,
          weekProgress: { done: doneThisWeek, total: tasksThisWeek.length, week: currentWeek, totalWeeks },
          fallback: 'day_done',
          skippedCount,
          message: skippedCount > 0
            ? 'You’ve skipped the rest of this week’s tasks. Reshuffle to bring them back.'
            : 'You’ve completed everything for this week. See you tomorrow.',
        },
      });
    }

    // Rank by lowest current mastery — weakest topics first.
    const topicMasteryFor = (canonicalName) => {
      const tp = knowledge?.topicProfiles?.[canonicalName];
      return tp?.masteryLevel ?? 0;
    };
    const ranked = [...availableThisWeek].sort(
      (a, b) => topicMasteryFor(a.topic?.canonicalName) - topicMasteryFor(b.topic?.canonicalName)
    );

    // The structured day = the top N available tasks. Mix types so it's not
    // 5 videos in a row — interleave by taskType where possible.
    const todaysTasks = pickStructuredDay(ranked, TODAYS_TASK_COUNT)
      .map(t => shapeTask(t, topicMasteryFor));

    const totalDurationMin = todaysTasks.reduce((s, t) => s + (t.durationMin || 0), 0);

    return res.json({
      success: true,
      data: {
        greeting,
        objectiveLabel,
        statusLine,
        trajectory,
        weekProgress: { done: doneThisWeek, total: tasksThisWeek.length, week: currentWeek, totalWeeks },
        todaysTasks,
        totalDurationMin,
        hasMoreThisWeek: ranked.length > todaysTasks.length,
        skippedCount,
      },
    });
  } catch (err) {
    console.error('[v2/plan/today] error', err);
    return res.status(500).json({ success: false, message: 'Failed to load today’s plan' });
  }
});

/**
 * POST /api/v2/plan/task/:taskId/skip
 * Marks a task skipped → it drops out of today's set, the next one slots in.
 */
router.post('/task/:taskId/skip', auth, (req, res) =>
  setTaskStatus(req, res, 'skipped'));

/**
 * POST /api/v2/plan/task/:taskId/complete
 * Tap-completion — flips the plan task to complete when the user finishes it.
 */
router.post('/task/:taskId/complete', auth, (req, res) =>
  setTaskStatus(req, res, 'complete'));

/**
 * Shared mutator — surgically updates one task's progress.status inside the
 * nested weeklySchedule[].tasks[] array, scoped to the user's active plan.
 */
async function setTaskStatus(req, res, status) {
  try {
    const userId = req.user.userId;
    const { taskId } = req.params;
    const update = {
      'weeklySchedule.$[].tasks.$[t].progress.status': status,
    };
    if (status === 'complete') {
      update['weeklySchedule.$[].tasks.$[t].progress.completedAt'] = new Date();
    }
    const result = await Plan.updateOne(
      { userId, isActive: true },
      { $set: update },
      { arrayFilters: [{ 't._id': taskId }] }
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: 'Active plan not found' });
    }
    return res.json({ success: true, data: { taskId, status } });
  } catch (err) {
    console.error('[v2/plan/task status] error', err);
    return res.status(500).json({ success: false, message: 'Failed to update task' });
  }
}

/**
 * POST /api/v2/plan/reshuffle
 * Un-skips every skipped task in the current week — "show me the full set again".
 */
router.post('/reshuffle', auth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const result = await Plan.updateOne(
      { userId, isActive: true },
      { $set: { 'weeklySchedule.$[].tasks.$[t].progress.status': 'pending' } },
      { arrayFilters: [{ 't.progress.status': 'skipped' }] }
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: 'Active plan not found' });
    }
    return res.json({ success: true, data: { reshuffled: true } });
  } catch (err) {
    console.error('[v2/plan/reshuffle] error', err);
    return res.status(500).json({ success: false, message: 'Failed to reshuffle' });
  }
});

/**
 * Pick a varied set of N tasks: greedily interleave by taskType so the day
 * isn't "5 of the same thing". Falls back to plain rank order if needed.
 */
function pickStructuredDay(rankedTasks, n) {
  if (rankedTasks.length <= n) return rankedTasks;
  const picked = [];
  const pool = [...rankedTasks];
  let lastType = null;
  while (picked.length < n && pool.length > 0) {
    // Prefer the highest-ranked task whose type differs from the last pick.
    let idx = pool.findIndex(t => t.type !== lastType);
    if (idx === -1) idx = 0; // all same type left — just take the top
    const [task] = pool.splice(idx, 1);
    picked.push(task);
    lastType = task.type;
  }
  return picked;
}

// ──────────────────────────────────────────────
// Shaping helpers
// ──────────────────────────────────────────────

/**
 * Unified task shaper — one shape for every task in the structured day.
 */
function shapeTask(task, topicMasteryFor) {
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
    title: task.payload?.title || task.topic?.displayName || 'Task',
    subtitle: task.payload?.creator || task.payload?.source || '',
    durationMin: task.payload?.estimatedMinutes || 15,
    difficulty: (task.payload?.difficulty || 3) >= 4 ? 'hard'
              : (task.payload?.difficulty || 3) <= 2 ? 'easy' : 'medium',
    primaryTopic: task.topic?.displayName || primaryTopicKey,
    reason: task.payload?.reason || `Builds your ${task.topic?.displayName || 'skills'}`,
    payload: extractPayload(task),
    impact,
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
