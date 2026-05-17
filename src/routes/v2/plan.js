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

    // The user has finished the v2 onboarding flow + diagnostic — clear the
    // re-onboard flag AND guarantee diagnosticComplete is set, so the next
    // launch routes them straight to v2 Home instead of back into the
    // diagnostic welcome. (finishAttempt sets diagnosticComplete too, but
    // belt-and-suspenders here covers any attempt that finished oddly.)
    await require('../../models/User').updateOne(
      { _id: req.user.userId },
      { $set: { v2NeedsOnboarding: false, diagnosticComplete: true } }
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

    const [user, objective, plan, knowledge, latestAttempt, competition, weekActivity] = await Promise.all([
      require('../../models/User').findById(userId).select('firstName').lean(),
      UserObjective.findOne({ userId, status: 'active', isPrimary: true }).lean(),
      Plan.findOne({ userId, isActive: true }).lean(),
      KnowledgeProfile.findOne({ userId }).lean(),
      require('../../models/DiagnosticAttempt')
        .findOne({ userId, status: 'completed' })
        .sort({ completedAt: -1 })
        .lean(),
      require('../../models/CompetitionProfile').findOne({ userId }).lean(),
      computeWeekActivity(userId),
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

    // Current readiness — keep this consistent with the Calibration screen
    // (/diagnostic/:id/insights). Prefer the diagnostic baseline (average of
    // measured competency scores), then the knowledge profile, then a floor.
    const currentReadiness =
      diagnosticBaselineReadiness(latestAttempt) ??
      computeReadinessFromKnowledge(knowledge) ??
      30;

    const trajectory = forecastTrajectory({
      currentReadiness,
      objectiveType: objective.objectiveType,
      specifics: objective.specifics || {},
      timeline: objective.timeline,
      currentLevel: objective.currentLevel,
    });

    const topGap = diagnosticTopGap(latestAttempt);
    const streak = {
      current: competition?.currentStreak || 0,
      longest: competition?.longestStreak || 0,
    };

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

    // Calendar-vs-plan drift. If the plan started 3 weeks ago but the user is
    // still showing week 1 tasks, they're 2 weeks behind — surface that so
    // Home can show a "Catching up" banner instead of pretending we're fine.
    const DAY_MS = 24 * 60 * 60 * 1000;
    const planStartedAt = plan.createdAt || plan.startedAt;
    const expectedWeek = planStartedAt
      ? Math.max(1, Math.floor((Date.now() - new Date(planStartedAt).getTime()) / (7 * DAY_MS)) + 1)
      : currentWeek;
    const behindByWeeks = Math.max(0, expectedWeek - currentWeek);
    // "available" = not completed and not skipped — these are eligible for today's set
    const availableThisWeek = tasksThisWeek.filter(
      t => t.progress?.status !== 'complete' && t.progress?.status !== 'skipped'
    );
    const doneThisWeek = tasksThisWeek.filter(t => t.progress?.status === 'complete').length;
    const skippedCount = tasksThisWeek.filter(t => t.progress?.status === 'skipped').length;
    const weeksRemaining = Math.max(0, totalWeeks - currentWeek);

    // Prefer a personal, specific status line — anchor on the user's
    // biggest measured gap when available. Falls back to the generic line.
    let statusLine;
    if (behindByWeeks > 0) {
      // Backlog takes precedence — the user needs to know they're behind
      // before we tell them anything else cheerful.
      statusLine = behindByWeeks === 1
        ? `You're a week behind. Catch up so you stay on track for your goal.`
        : `You're ${behindByWeeks} weeks behind. Today's tasks + the backlog below will get you back on pace.`;
    } else if (topGap && topGap.score < 50) {
      const prettyTopic = topGap.topic.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      statusLine = `Your biggest lift is ${prettyTopic} (${topGap.score}%). Today's set chips away at it.`;
    } else if (trajectory.onTrack) {
      statusLine = `You're on track. ${currentReadiness}% ready, ${weeksRemaining} weeks to go.`;
    } else {
      statusLine = `Behind pace. ${currentReadiness}% ready, ${weeksRemaining} weeks left — let’s tighten up.`;
    }

    // "Get ahead" pool — next week's first 3 tasks, ALWAYS shaped so iOS can
    // surface them when the user finishes today's set (so there's always
    // something to do). Pulled from the very next non-complete week.
    const nextWeekEntry = plan.weeklySchedule.find(
      w => w.week > currentWeek && (w.tasks || []).some(t => t.progress?.status !== 'complete')
    );
    const nextWeekAvailable = nextWeekEntry
      ? (nextWeekEntry.tasks || []).filter(t => t.progress?.status !== 'complete' && t.progress?.status !== 'skipped')
      : [];

    if (availableThisWeek.length === 0) {
      // Week done — but always offer "get ahead" so the user has something
      // actionable instead of being told to come back tomorrow.
      const getAheadShaped = nextWeekAvailable.slice(0, 3)
        .map(t => shapeTask(t, (canonical) => (knowledge?.topicProfiles?.[canonical]?.masteryLevel ?? 0)));
      return res.json({
        success: true,
        data: {
          greeting,
          objectiveLabel,
          statusLine,
          trajectory,
          weekProgress: { done: doneThisWeek, total: tasksThisWeek.length, week: currentWeek, totalWeeks },
          streak,
          weekActivity,
          topGap,
          fallback: 'day_done',
          skippedCount,
          behindByWeeks,
          getAheadTasks: getAheadShaped,
          getAheadWeek: nextWeekEntry?.week,
          message: skippedCount > 0
            ? 'You’ve skipped the rest of this week’s tasks. Reshuffle to bring them back.'
            : (getAheadShaped.length > 0
                ? 'Week ' + currentWeek + ' done — get a head start on week ' + nextWeekEntry.week + '.'
                : 'You’ve completed everything for this week. See you tomorrow.'),
        },
      });
    }

    // Rank by lowest current mastery — weakest topics first.
    const topicMasteryFor = (canonicalName) => {
      const tp = knowledge?.topicProfiles?.[canonicalName];
      return tp?.masteryLevel ?? 0;
    };
    const ranked = [...availableThisWeek].sort((a, b) => {
      const am = topicMasteryFor(a.topic?.canonicalName);
      const bm = topicMasteryFor(b.topic?.canonicalName);
      return am - bm;
    });

    // ── Issue B: inject up to 1 content recommendation into the pool ─────────
    // The plan task pool is all-assessment (quiz/compete/interview). Inject
    // one content piece (video/article/notes) so the day has learning mixed in.
    // We cap at 1 so it doesn't crowd out plan tasks on short weeks.
    try {
      const recommendationService = require('../../services/recommendationService');
      const recResult = await recommendationService.getPersonalizedFeed(userId, { page: 1, limit: 3 });
      const recItems = recResult?.items || [];
      if (recItems.length > 0) {
        const pick = recItems[0]; // highest-scored recommendation
        const contentTypeToTaskType = {
          video:       { type: 'in_app_content', uiType: 'watch', icon: '📺' },
          article:     { type: 'external_link',  uiType: 'read',  icon: '📄' },
          notes:       { type: 'in_app_content', uiType: 'read',  icon: '🧠' },
          infographic: { type: 'in_app_content', uiType: 'watch', icon: '📺' },
        };
        const ctMap = contentTypeToTaskType[pick.contentType] || contentTypeToTaskType.video;
        const durationMin = pick.duration ? Math.ceil(pick.duration / 60) : 10;
        // Shape as a pseudo-plan task so it flows through pickStructuredDay and
        // the existing ranked.filter pendingPriorTasks logic unmodified.
        const syntheticTask = {
          _id: `content:${pick._id}`,
          type: ctMap.type,
          _isContentInjection: true,
          topic: {
            canonicalName: (pick.topics || [])[0] || null,
            displayName: (pick.topics || [])[0] || 'Learning',
          },
          payload: {
            contentId: String(pick._id),
            title: pick.title,
            creator: pick.creator || pick.creatorId?.username || '',
            estimatedMinutes: durationMin,
            difficulty: 2, // treat as medium (maps to 'medium' in shapeTask)
            reason: `Recommended for your ${(pick.topics || [])[0] || 'goal'}`,
          },
          progress: { status: 'pending' },
        };
        ranked.push(syntheticTask);
      }
    } catch (recErr) {
      // Non-critical — daily plan still works without the content injection.
      console.warn('[v2/plan/today] content injection failed (non-fatal):', recErr.message);
    }

    // The structured day = the top N available tasks. Mix types so it's not
    // 5 of the same thing — interleave by taskType, with day-of-year rotation
    // so consecutive days surface different starting slices (Issue A).
    const todaysTasks = pickStructuredDay(ranked, TODAYS_TASK_COUNT)
      .map(t => shapeTask(t, topicMasteryFor));

    const totalDurationMin = todaysTasks.reduce((s, t) => s + (t.durationMin || 0), 0);

    // Pending = everything in the current pool that isn't in today's set.
    // These are the "carryover" tasks from prior days the user hasn't done
    // yet — surfaced under a separate "Pending from previous days" section.
    const todaysIds = new Set(todaysTasks.map(t => t.taskId));
    const pendingPriorTasks = ranked
      .filter(t => !todaysIds.has(String(t._id)))
      .map(t => shapeTask(t, topicMasteryFor));

    // Always include get-ahead so the iOS client can show "More to do" once
    // the user finishes today's set without round-tripping for /plan/today.
    const getAheadTasks = nextWeekAvailable.slice(0, 3)
      .map(t => shapeTask(t, topicMasteryFor));

    return res.json({
      success: true,
      data: {
        greeting,
        objectiveLabel,
        statusLine,
        trajectory,
        weekProgress: { done: doneThisWeek, total: tasksThisWeek.length, week: currentWeek, totalWeeks },
        streak,
        weekActivity,
        topGap,
        todaysTasks,
        totalDurationMin,
        hasMoreThisWeek: ranked.length > todaysTasks.length,
        skippedCount,
        // New: backlog + get-ahead surfaces (Home renders these as their own sections)
        behindByWeeks,
        pendingPriorTasks,
        pendingPriorCount: pendingPriorTasks.length,
        getAheadTasks,
        getAheadWeek: nextWeekEntry?.week,
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
 * Pick a varied set of N tasks: rotate the start position by day-of-year so
 * consecutive days see a different slice of the same week's pool (Issue A),
 * then greedily interleave by taskType to avoid runs of identical types.
 */
function pickStructuredDay(rankedTasks, n) {
  if (rankedTasks.length <= n) return rankedTasks;

  // Rotate the starting index by day-of-year so each day surfaces a
  // different starting point in the ranked pool. Within a single day the
  // pick is stable; the next day a different offset is used.
  const dayOfYear = Math.floor(
    (Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) /
    (24 * 60 * 60 * 1000)
  );
  const start = dayOfYear % rankedTasks.length;
  const rotated = [...rankedTasks.slice(start), ...rankedTasks.slice(0, start)];

  // Greedy type-interleave on the rotated pool (existing behaviour).
  const picked = [];
  const pool = [...rotated];
  let lastType = null;
  while (picked.length < n && pool.length > 0) {
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

/**
 * Baseline readiness from a completed diagnostic — the average of measured
 * competency scores in `attempt.results`. MUST match the calculation in
 * /diagnostic/:id/insights so Home and the Calibration screen agree.
 */
function diagnosticBaselineReadiness(attempt) {
  if (!attempt) return null;
  const resultsMap = attempt.results instanceof Map
    ? Object.fromEntries(attempt.results)
    : (attempt.results || {});
  const scores = Object.values(resultsMap)
    .map(r => (r && typeof r.score === 'number' ? r.score : null))
    .filter(s => s !== null);
  if (scores.length === 0) return null;
  return Math.round(scores.reduce((s, v) => s + v, 0) / scores.length);
}

/**
 * Top gap from the diagnostic — the competency with the lowest measured
 * score. Powers the Home "why today matters" status line and the streak/grid.
 */
function diagnosticTopGap(attempt) {
  if (!attempt) return null;
  const resultsMap = attempt.results instanceof Map
    ? Object.fromEntries(attempt.results)
    : (attempt.results || {});
  let lowest = null;
  for (const [topic, r] of Object.entries(resultsMap)) {
    if (!r || typeof r.score !== 'number') continue;
    if (!lowest || r.score < lowest.score) {
      lowest = { topic, score: Math.round(r.score), band: r.assessedBand || null };
    }
  }
  return lowest;
}

/**
 * "Did the user complete anything on this day this week?" — Monday→Sunday.
 * Used by Home's weekly-grid streak strip.
 */
async function computeWeekActivity(userId) {
  const QuizAttempt = require('../../models/QuizAttempt');
  const ContentProgress = require('../../models/ContentProgress');
  const InterviewSession = require('../../models/InterviewSession');

  // Start of this week (Monday 00:00 local-ish, server time is fine for a 7-bucket grid).
  const now = new Date();
  const monday = new Date(now);
  const dayOfWeek = (monday.getDay() + 6) % 7; // 0 = Monday
  monday.setDate(monday.getDate() - dayOfWeek);
  monday.setHours(0, 0, 0, 0);

  const since = monday;
  const [quizzes, content, interviews] = await Promise.all([
    QuizAttempt.find({ userId, status: 'completed', completedAt: { $gte: since } })
      .select('completedAt').lean(),
    ContentProgress.find({ userId, isCompleted: true, completedAt: { $gte: since } })
      .select('completedAt').lean(),
    InterviewSession.find({ userId, status: { $in: ['completed', 'evaluated'] }, completedAt: { $gte: since } })
      .select('completedAt').lean(),
  ]);

  // Build a 7-element bool array — Mon..Sun.
  const buckets = Array.from({ length: 7 }, () => false);
  const stamp = (d) => {
    if (!d) return;
    const idx = (new Date(d).getDay() + 6) % 7;
    if (idx >= 0 && idx < 7) buckets[idx] = true;
  };
  quizzes.forEach(q => stamp(q.completedAt));
  content.forEach(c => stamp(c.completedAt));
  interviews.forEach(i => stamp(i.completedAt));

  const labels = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const todayIdx = (now.getDay() + 6) % 7;
  return labels.map((label, idx) => ({
    label,
    hadActivity: buckets[idx],
    isToday: idx === todayIdx,
  }));
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
