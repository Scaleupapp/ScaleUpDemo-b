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
    const objectiveName = buildObjectiveName(objective);

    if (!objective) {
      return res.json({
        success: true,
        data: {
          greeting,
          statusLine: "Let's set you up — about 10 minutes.",
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
      userId,   // enables velocity measurement
      plan,     // in-memory doc — no extra DB hit
      targetReadiness: require('../../services/readiness/targetService').getEffectiveTarget(objective),
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
          objectiveName,
          statusLine: "Your plan is being personalized. Meanwhile, here's content relevant to your goal.",
          trajectory,
          fallback: 'plan_brewing',
          weekProgress: null,
          planSchedule: [],
          bonusTasks: [],
        },
      });
    }

    // Find current week from earliest week with any incomplete tasks
    // These are declared with `let` so the auto-promote block (below) can
    // shadow them with the next week's values when the current week is clean-done.
    let currentWeekEntry =
      plan.weeklySchedule.find(w => w.tasks.some(t => t.progress?.status !== 'complete')) ||
      plan.weeklySchedule[0];

    let currentWeek = currentWeekEntry.week;
    const totalWeeks = plan.weeklySchedule.length;
    let tasksThisWeek = currentWeekEntry.tasks || [];

    // Calendar-vs-plan drift. If the plan started 3 weeks ago but the user is
    // still showing week 1 tasks, they're 2 weeks behind — surface that so
    // Home can show a "Catching up" banner instead of pretending we're fine.
    const DAY_MS = 24 * 60 * 60 * 1000;
    const planStartedAt = plan.createdAt || plan.startedAt;
    const expectedWeek = planStartedAt
      ? Math.max(1, Math.floor((Date.now() - new Date(planStartedAt).getTime()) / (7 * DAY_MS)) + 1)
      : currentWeek;
    const behindByWeeks = Math.max(0, expectedWeek - currentWeek);
    // "available" = not completed and not skipped — these are eligible for today's set.
    // Remove compete tasks — they're surfaced via Compass / Competition Home,
    // not the daily structured plan. Plan compete tasks have a misleading
    // contract: their title implies a specific subtopic but they all point
    // to the same cohort-wide daily challenge.
    const COMPETE_V1_TYPES = new Set(['competition']);
    const filterCompete = (arr) => (arr || []).filter(t => !COMPETE_V1_TYPES.has(t.type));
    // Declared with `let` so the auto-promote block can reassign them.
    let availableThisWeek = filterCompete(tasksThisWeek.filter(
      t => t.progress?.status !== 'complete' && t.progress?.status !== 'skipped'
    ));
    let doneThisWeek = tasksThisWeek.filter(t => t.progress?.status === 'complete').length;
    let skippedCount = tasksThisWeek.filter(t => t.progress?.status === 'skipped').length;
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
      statusLine = `Behind pace. ${currentReadiness}% ready, ${weeksRemaining} weeks left — let's tighten up.`;
    }

    // "Get ahead" pool — next week's first 3 tasks, ALWAYS shaped so iOS can
    // surface them when the user finishes today's set (so there's always
    // something to do). Pulled from the very next non-complete week.
    // Declared with `let` so the auto-promote block can advance them.
    let nextWeekEntry = plan.weeklySchedule.find(
      w => w.week > currentWeek && (w.tasks || []).some(t => t.progress?.status !== 'complete')
    );
    let nextWeekAvailable = nextWeekEntry
      ? filterCompete((nextWeekEntry.tasks || []).filter(t => t.progress?.status !== 'complete' && t.progress?.status !== 'skipped'))
      : [];

    // ── Auto-promote next week (Fix 3) ───────────────────────────────────────
    // When the current week is fully complete (nothing skipped, nothing left)
    // AND the next week has available tasks, silently promote them into
    // today's structured set instead of showing a 'come back tomorrow' wall.
    // We mutate the local variables only — the plan doc in DB is untouched.
    {
      const allCurrentDone = doneThisWeek === tasksThisWeek.length;
      if (availableThisWeek.length === 0 && allCurrentDone && nextWeekEntry && nextWeekAvailable.length > 0) {
        // Advance to next week's data.
        currentWeekEntry = nextWeekEntry;
        currentWeek = nextWeekEntry.week;
        tasksThisWeek = nextWeekEntry.tasks || [];
        availableThisWeek = filterCompete(tasksThisWeek.filter(
          t => t.progress?.status !== 'complete' && t.progress?.status !== 'skipped'
        ));
        doneThisWeek = tasksThisWeek.filter(t => t.progress?.status === 'complete').length;
        skippedCount = tasksThisWeek.filter(t => t.progress?.status === 'skipped').length;

        // Advance the get-ahead pool to the week after the promoted one.
        const nextNextWeekEntry = plan.weeklySchedule.find(
          w => w.week > nextWeekEntry.week && (w.tasks || []).some(t => t.progress?.status !== 'complete')
        );
        nextWeekEntry = nextNextWeekEntry || null;
        nextWeekAvailable = nextNextWeekEntry
          ? filterCompete((nextNextWeekEntry.tasks || []).filter(t => t.progress?.status !== 'complete' && t.progress?.status !== 'skipped'))
          : [];
      }
    }

    if (availableThisWeek.length === 0) {
      // Week is "done" by status (everything is complete OR skipped) but the
      // user shouldn't hit a wall. Synthesise bonus tasks (today's daily
      // challenge + weak-topic quizzes) so there's always something to grab.
      // If we end up with any bonus tasks, fall through to the normal
      // structured-day response with them as todaysTasks. Otherwise fall back
      // to the day_done celebration.
      const allDone = doneThisWeek === tasksThisWeek.length;
      const someSkipped = skippedCount > 0;

      const bonusRanked = await synthesizeBonusTasks({
        userId, objective, knowledge,
      });

      const getAheadShaped = nextWeekAvailable.slice(0, 3)
        .map(t => shapeTask(t, (canonical) => (knowledge?.topicProfiles?.[canonical]?.masteryLevel ?? 0)));

      // Coach mode is now a top-level, always-available entry point on Home —
      // no longer auto-surfaced as a plan task here. See V2HomeView "Talk to
      // Coach" card. The synthetic compass_review task is intentionally not
      // inserted in either branch below.

      if (bonusRanked.length > 0) {
        // Build a structured day from bonus tasks + falling through into the
        // normal response shape so iOS renders the cards instead of celebration.
        const todaysTasks = pickStructuredDay(bonusRanked, TODAYS_TASK_COUNT)
          .map(t => shapeTask(t, (canonical) => (knowledge?.topicProfiles?.[canonical]?.masteryLevel ?? 0)));

        const totalDurationMin = todaysTasks.reduce((s, t) => s + (t.durationMin || 0), 0);
        const weeklyInsightBonus = buildWeeklyInsight({ topGap, todaysTasks, weekProgress: { done: doneThisWeek, total: tasksThisWeek.length, week: currentWeek, totalWeeks }, trajectory });

        // Surface any additional bonus tasks not picked into today's set as the
        // "Push Harder" pool (capped at 3 so the chip stays digestible).
        const pickedIds = new Set(todaysTasks.map(t => t.taskId));
        const bonusShaped = bonusRanked
          .map(t => shapeTask(t, (canonical) => (knowledge?.topicProfiles?.[canonical]?.masteryLevel ?? 0)))
          .filter(t => !pickedIds.has(t.taskId))
          .slice(0, 3);

        return res.json({
          success: true,
          data: {
            greeting,
            objectiveLabel,
            objectiveName,
            statusLine: allDone
              ? `Week ${currentWeek} wrapped. Bonus picks below — keep the momentum.`
              : statusLine,
            trajectory,
            weekProgress: { done: doneThisWeek, total: tasksThisWeek.length, week: currentWeek, totalWeeks },
            planSchedule: buildPlanSchedule(plan, currentWeek),
            streak,
            weekActivity,
            topGap,
            todaysTasks,
            totalDurationMin,
            hasMoreThisWeek: false,
            skippedCount,
            behindByWeeks,
            pendingPriorTasks: [],
            pendingPriorCount: 0,
            getAheadTasks: getAheadShaped,
            getAheadWeek: nextWeekEntry?.week,
            bonusTasks: bonusShaped,
            weeklyInsight: weeklyInsightBonus,
          },
        });
      }

      // Genuine day_done: no bonus material available either. Celebration path.
      let weekDoneMessage;
      if (allDone) {
        weekDoneMessage = nextWeekEntry
          ? `Week ${currentWeek} done — get a head start on week ${nextWeekEntry.week}.`
          : `Week ${currentWeek} done. See you tomorrow.`;
      } else if (someSkipped) {
        weekDoneMessage = `${doneThisWeek} of ${tasksThisWeek.length} done this week · ${skippedCount} skipped. Reshuffle to bring them back.`;
      } else {
        weekDoneMessage = `Done for now. See you tomorrow.`;
      }

      const weeklyInsightDayDone = buildWeeklyInsight({ topGap, todaysTasks: [], weekProgress: { done: doneThisWeek, total: tasksThisWeek.length, week: currentWeek, totalWeeks }, trajectory });

      // Coach mode is now an always-available top-level entry on Home —
      // no longer auto-surfaced as a synthetic plan task in the day_done
      // celebration path either.

      let dayDoneCapstone = null;
      try {
        const codingPlan = require('../../coding/services/planIntegration');
        dayDoneCapstone = await codingPlan.getCapstoneMilestone(userId).catch(() => null);
      } catch (_) { /* non-fatal */ }

      return res.json({
        success: true,
        data: {
          greeting,
          objectiveLabel,
          objectiveName,
          statusLine,
          trajectory,
          weekProgress: { done: doneThisWeek, total: tasksThisWeek.length, week: currentWeek, totalWeeks },
          planSchedule: buildPlanSchedule(plan, currentWeek),
          streak,
          weekActivity,
          topGap,
          fallback: 'day_done',
          skippedCount,
          behindByWeeks,
          getAheadTasks: getAheadShaped,
          getAheadWeek: nextWeekEntry?.week,
          bonusTasks: [],
          weeklyInsight: weeklyInsightDayDone,
          message: weekDoneMessage,
          capstoneMilestone: dayDoneCapstone,
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

    // ── Fix 4: Bonus tasks when the ranked pool is empty ─────────────────────
    // At this point auto-promote has already run. If we still have nothing,
    // synthesise bonus material so Home always has something to do.
    if (ranked.length === 0) {
      const bonus = await synthesizeBonusTasks({ userId, objective, knowledge });
      ranked.push(...bonus);
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

    const weeklyInsight = buildWeeklyInsight({ topGap, todaysTasks, weekProgress: { done: doneThisWeek, total: tasksThisWeek.length, week: currentWeek, totalWeeks }, trajectory });

    // Coach mode (formerly "Weekly Compass review") is no longer surfaced
    // as a synthetic plan task. It's a top-level entry point on V2HomeView
    // ("Talk to Coach") so the user can invoke it anytime, with a scope
    // chooser (This Week / This Month / Since Start / By Topic).

    // ── "Push Harder" pool ───────────────────────────────────────────────────
    // Always synthesise a small bonus list (today's daily challenge + weak-topic
    // quizzes) so the V2 Home "Push Harder" chip has something to reveal even
    // when the user has plenty of plan tasks. Capped at 3.
    let bonusTasks = [];
    try {
      const bonus = await synthesizeBonusTasks({ userId, objective, knowledge });
      bonusTasks = bonus.slice(0, 3).map(t => shapeTask(t, topicMasteryFor));
    } catch (bonusErr) {
      console.warn('[v2/plan/today] bonus synthesis failed (non-fatal):', bonusErr.message);
    }

    // Coding integrations — non-fatal. Daily drill candidate + weekly
    // capstone milestone are surfaced as separate top-level fields so
    // the mobile client renders them as distinct cards (not mixed into
    // the day's task list).
    let drillCandidate = null;
    let capstoneMilestone = null;
    try {
      const codingPlan = require('../../coding/services/planIntegration');
      [drillCandidate, capstoneMilestone] = await Promise.all([
        codingPlan.getDrillCandidate(userId).catch(() => null),
        codingPlan.getCapstoneMilestone(userId).catch(() => null),
      ]);
    } catch (codingErr) {
      console.warn('[v2/plan/today] coding integration failed (non-fatal):', codingErr.message);
    }

    return res.json({
      success: true,
      data: {
        greeting,
        objectiveLabel,
        objectiveName,
        statusLine,
        trajectory,
        weekProgress: { done: doneThisWeek, total: tasksThisWeek.length, week: currentWeek, totalWeeks },
        planSchedule: buildPlanSchedule(plan, currentWeek),
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
        bonusTasks,
        weeklyInsight,
        drillCandidate,
        capstoneMilestone,
      },
    });
  } catch (err) {
    console.error('[v2/plan/today] error', err);
    return res.status(500).json({ success: false, message: "Failed to load today's plan" });
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

    // Synthetic taskIds (not stored on weeklySchedule.tasks[]) — handled
    // out-of-band. Today: the weekly Compass review (`review-week-<N>`)
    // toggles a flag on Plan.reviewedWeeks so we don't re-surface it.
    const reviewMatch = /^review-week-(\d+)$/.exec(taskId);
    if (reviewMatch) {
      if (status === 'complete') {
        const weekNum = parseInt(reviewMatch[1], 10);
        const r = await Plan.updateOne(
          { userId, isActive: true },
          { $addToSet: { reviewedWeeks: weekNum } }
        );
        if (r.matchedCount === 0) {
          return res.status(404).json({ success: false, message: 'Active plan not found' });
        }
      }
      // Skip on a review is a soft no-op (we still don't want to re-surface
      // it the same day) — mark it done so the user isn't nagged.
      if (status === 'skipped') {
        const weekNum = parseInt(reviewMatch[1], 10);
        await Plan.updateOne(
          { userId, isActive: true },
          { $addToSet: { reviewedWeeks: weekNum } }
        );
      }
      return res.json({ success: true, data: { taskId, status } });
    }

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
 * `topic` is included so bonus quiz tasks (taskType='quiz', quizId=null) can
 * route through V2QuizRequestLoaderSheet via the on-demand quiz flow.
 */
function extractPayload(task) {
  const p = task.payload || {};
  return {
    contentId:   p.contentId   || null,
    quizId:      p.quizId      || null,
    interviewId: p.interviewId || p.scenarioId || null,
    url:         p.url         || null,
    topic:       p.topic       || null,
    challengeId: p.challengeId || null,
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

/**
 * Single-sentence, rule-based insight for why this week matters.
 * No LLM call — deterministic and fast.
 *
 * @param {Object} args
 * @param {Object|null} args.topGap       - { topic, score } from diagnosticTopGap
 * @param {Array}       args.todaysTasks  - shaped tasks array (may be empty for day_done)
 * @param {Object}      args.weekProgress - { done, total, week, totalWeeks }
 * @param {Object}      args.trajectory   - forecastTrajectory result
 * @returns {string|null}
 */
function buildWeeklyInsight({ topGap, todaysTasks, weekProgress, trajectory }) {
  if (!topGap) return null;

  const prettyTopic = topGap.topic.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const matchingTaskCount = (todaysTasks || []).filter(t =>
    (t.primaryTopic || '').toLowerCase() === topGap.topic.toLowerCase()
  ).length;

  if (matchingTaskCount > 0) {
    const taskWord = matchingTaskCount === 1
      ? "Today's quiz on it"
      : `Today's ${matchingTaskCount} tasks on it`;
    return `${prettyTopic} is your biggest gap (${topGap.score}%). ${taskWord} can lift your readiness by ~${matchingTaskCount * 2}% this week.`;
  } else if (trajectory?.velocitySource === 'measured' && trajectory.realTasksPerWeek < 3) {
    return `${prettyTopic} is your biggest gap (${topGap.score}%). You averaged ${trajectory.realTasksPerWeek} tasks/week — pushing to 5+ this week will measurably move your readiness.`;
  } else {
    return `${prettyTopic} is your biggest gap (${topGap.score}%). Add a quiz on it via Compass to start chipping away.`;
  }
}

/**
 * Bonus task synthesis — used in two places:
 *  (1) the structured-day path when the ranked pool ends up empty after the
 *      content-injection step
 *  (2) the day_done branch so users who finish (or skip-out) of the week
 *      still see actionable tasks instead of a celebration wall
 *
 * Returns plan-shaped task objects (NOT shaped UI tasks) — caller maps them
 * through `shapeTask`. Returns at most 1 daily-challenge bonus + N weak-topic
 * quizzes.
 */
async function synthesizeBonusTasks({ userId, objective, knowledge }) {
  const out = [];
  const prettyTopicName = (s) =>
    (s || '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  // (1) Today's unplayed daily challenge for the user's cohort.
  if (objective?.canonicalTopic) {
    try {
      const DailyChallenge = require('../../models/DailyChallenge');
      const ChallengeAttempt = require('../../models/ChallengeAttempt');
      const todayIST = (() => {
        const d = new Date();
        d.setUTCHours(d.getUTCHours() + 5, d.getUTCMinutes() + 30, 0, 0);
        d.setUTCHours(0, 0, 0, 0);
        return d;
      })();
      const challenge = await DailyChallenge.findOne({
        topic: objective.canonicalTopic,
        date: todayIST,
        status: 'active',
      }).lean().catch(() => null);
      if (challenge) {
        const alreadyPlayed = await ChallengeAttempt.exists({
          userId, challengeId: challenge._id, completedAt: { $ne: null },
        }).catch(() => null);
        if (!alreadyPlayed) {
          out.push({
            _id: `bonus-compete:${challenge._id}`,
            type: 'competition',
            _isBonusCompete: true,
            topic: {
              canonicalName: objective.canonicalTopic,
              displayName: prettyTopicName(objective.canonicalTopic),
            },
            payload: {
              title: `Today's challenge: ${prettyTopicName(objective.canonicalTopic)}`,
              creator: 'Timed · ranked · 30 sec per question',
              estimatedMinutes: Math.ceil((challenge.totalDurationSeconds || (challenge.questions?.length || 15) * 30) / 60),
              difficulty: challenge.difficulty === 'hard' ? 4 : challenge.difficulty === 'easy' ? 2 : 3,
              reason: 'Bonus — compete with the rest of your cohort today.',
              impact: {
                expectedFrom: null,
                expectedTo: null,
                expectedGain: null,
                whyText: 'Daily challenge against your cohort.',
                scope: 'competition',
              },
              quizId: null,
              contentId: null,
              interviewId: null,
              url: null,
              challengeId: String(challenge._id),
              topic: objective.canonicalTopic,
            },
            progress: { status: 'pending' },
          });
        }
      }
    } catch (compErr) {
      console.warn('[v2/plan/today] bonus competition injection failed (non-fatal):', compErr.message);
    }
  }

  // (2) Weakest-topic bonus quizzes — falls back to objective.canonicalTopic
  // for users who haven't taken a quiz on anything yet (otherwise the filter
  // below excludes them and we surface no quizzes at all).
  let weakTopics = (knowledge?.topicMastery || [])
    .filter(t => (t.quizzesTaken || 0) >= 1)
    .sort((a, b) => (a.score || 0) - (b.score || 0))
    .slice(0, 2);

  if (weakTopics.length === 0 && objective?.canonicalTopic) {
    weakTopics = [{ topic: objective.canonicalTopic, score: 0 }];
  }

  for (let i = 0; i < weakTopics.length; i++) {
    const t = weakTopics[i];
    out.push({
      _id: `bonus-quiz:${t.topic}:${Date.now()}-${i}`,
      type: 'quiz',
      _isBonusQuiz: true,
      topic: { canonicalName: t.topic, displayName: prettyTopicName(t.topic) },
      payload: {
        title: `Quiz: ${prettyTopicName(t.topic)}`,
        estimatedMinutes: 8,
        difficulty: 2,
        reason: 'Bonus — keep the momentum going.',
        impact: {
          expectedFrom: t.score || 0,
          expectedTo: Math.min(100, (t.score || 0) + 5),
          expectedGain: 5,
          whyText: 'Bonus quiz on a topic you can still sharpen.',
          scope: 'topic',
        },
        quizId: null,
        contentId: null,
        interviewId: null,
        url: null,
        topic: t.topic,
      },
      progress: { status: 'pending' },
    });
  }

  return out;
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

/**
 * Short, uppercase objective name for the V2 Home status-bar eyebrow.
 * E.g. "GMAT", "SDE @ GOOGLE". Capped at 12 chars to keep the
 * "{OBJECTIVE} READINESS" line on one line on small phones.
 */
function buildObjectiveName(obj) {
  if (!obj) return null;
  const s = obj.specifics || {};
  let raw = s.examName || s.targetRole || s.targetSkill || obj.objectiveType || '';
  raw = String(raw).replace(/_/g, ' ').trim();
  if (s.targetRole && s.targetCompany) {
    raw = `${s.targetRole} @ ${s.targetCompany}`;
  }
  const upper = raw.toUpperCase();
  return upper.length > 12 ? upper.slice(0, 12) : upper;
}

/**
 * Derive a compact per-week summary across the entire plan for the V2 Home
 * "YOUR PLAN" timeline. Each entry is { week, total, done, skipped, isCurrent }.
 */
function buildPlanSchedule(plan, currentWeek) {
  if (!plan || !Array.isArray(plan.weeklySchedule)) return [];
  return plan.weeklySchedule.map(w => {
    const tasks = w.tasks || [];
    const done = tasks.filter(t => t.progress?.status === 'complete').length;
    const skipped = tasks.filter(t => t.progress?.status === 'skipped').length;
    return {
      week: w.week,
      total: tasks.length,
      done,
      skipped,
      isCurrent: w.week === currentWeek,
    };
  });
}

module.exports = router;
