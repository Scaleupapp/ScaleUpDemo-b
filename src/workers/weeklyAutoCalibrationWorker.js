/**
 * Weekly Auto-Calibration Worker
 *
 * Daily nightly (03:00 IST) — finds active users with strong recent activity
 * signal whose last diagnostic attempt is >= 7 days old, and "softly realigns"
 * their plan by re-running the post-processor (taskCatalogService.resolveTopic)
 * on the current and future weeks. This refreshes pending/in_progress quiz +
 * in_app_content tasks while preserving completed tasks AND
 * interview/competition/manual/external_link tasks (those have separate
 * lifecycles).
 *
 * Signal score = tasksCompletedLast7d + 2*interviewsLast7d + externalTouchesLast7d.
 * Threshold = 5. Below that, skip silently.
 *
 * No full plan regeneration — that's what /plan/recalibrate is for.
 */

const Plan = require('../models/Plan');
const QuizAttempt = require('../models/QuizAttempt');
const ContentProgress = require('../models/ContentProgress');
const InterviewSession = require('../models/InterviewSession');
const ExternalContentTouch = require('../models/ExternalContentTouch');
const DiagnosticAttempt = require('../models/DiagnosticAttempt');
const UserObjective = require('../models/UserObjective');
const taskCatalogService = require('../services/plan/taskCatalogService');
const { notificationQueue } = require('../config/queue');

const SIGNAL_THRESHOLD = 5;
const MIN_DAYS_SINCE_LAST_ATTEMPT = 7;

async function computeSignal(userId, since) {
  const [tasksCompleted, contentProgresses, interviews, externalTouches] = await Promise.all([
    QuizAttempt.countDocuments({ userId, status: 'completed', completedAt: { $gte: since } }),
    ContentProgress.countDocuments({ userId, isCompleted: true, completedAt: { $gte: since } }),
    InterviewSession.countDocuments({ userId, status: 'evaluated', completedAt: { $gte: since } }),
    ExternalContentTouch.countDocuments({ userId, completedAt: { $gte: since } }),
  ]);
  return tasksCompleted + contentProgresses + 2 * interviews + externalTouches;
}

/**
 * Re-runs taskCatalogService.resolveTopic on the active plan's current+future
 * weeks. Replaces pending/in_progress quiz + in_app_content tasks with refreshed
 * ones. Preserves completed tasks AND interview/competition/manual/external_link
 * tasks (those have separate lifecycles).
 */
async function softRealignPlan(plan, objectiveType /* , specificsCanonical */) {
  // Find the current week — first week with any pending/in_progress task
  let currentIdx = 0;
  for (let i = 0; i < plan.weeklySchedule.length; i++) {
    const hasOpen = (plan.weeklySchedule[i].tasks || []).some(t =>
      t.progress?.status === 'pending' || t.progress?.status === 'in_progress'
    );
    if (hasOpen) { currentIdx = i; break; }
  }

  let weeksTouched = 0;
  for (let i = currentIdx; i < plan.weeklySchedule.length; i++) {
    const week = plan.weeklySchedule[i];
    const existing = week.tasks || [];
    // Preserve all non-(quiz/in_app_content) tasks AND completed quiz/content tasks
    const preserved = existing.filter(t => {
      if (t.type !== 'quiz' && t.type !== 'in_app_content') return true;
      if (t.progress?.status === 'complete') return true;
      return false;
    });
    // Build refreshed quiz + in_app_content tasks for each allocation
    const refreshed = [];
    for (const alloc of (week.allocations || [])) {
      const resolved = await taskCatalogService.resolveTopic({
        topicCanonicalName: alloc.topicCanonicalName,
        objectiveType,
        objectiveId: plan.objectiveId,
        userId: String(plan.userId),
      });
      const displayName = alloc.topicCanonicalName
        .replace(/-/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
      const topicShape = { canonicalName: alloc.topicCanonicalName, displayName };

      // Skip emitting a new quiz/content if a completed one for this topic
      // already exists in `preserved` (don't duplicate).
      const hasCompletedQuiz = preserved.some(t =>
        t.type === 'quiz' &&
        t.topic?.canonicalName === alloc.topicCanonicalName &&
        t.progress?.status === 'complete'
      );
      const hasCompletedContent = preserved.some(t =>
        t.type === 'in_app_content' &&
        t.topic?.canonicalName === alloc.topicCanonicalName &&
        t.progress?.status === 'complete'
      );

      if (resolved.quizId && !hasCompletedQuiz) {
        refreshed.push({
          type: 'quiz',
          topic: topicShape,
          payload: { quizId: resolved.quizId, estimatedMinutes: resolved.quizMinutes },
          completion: { mode: 'auto', requiresSelfRating: false },
          progress: { status: 'pending', completedAt: null, selfRating: null, sourceEventId: null },
        });
      }
      if (resolved.contentId && !hasCompletedContent) {
        refreshed.push({
          type: 'in_app_content',
          topic: topicShape,
          payload: {
            contentId: resolved.contentId,
            contentType: resolved.contentType,
            estimatedMinutes: resolved.contentMinutes,
          },
          completion: { mode: 'auto', requiresSelfRating: false },
          progress: { status: 'pending', completedAt: null, selfRating: null, sourceEventId: null },
        });
      }
    }
    week.tasks = [...preserved, ...refreshed];
    weeksTouched++;
  }
  if (weeksTouched > 0 && typeof plan.save === 'function') {
    await plan.save();
  }
  return weeksTouched;
}

async function runWeeklyAutoCalibration() {
  console.log('[weeklyAutoCalibration] starting');
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const cursor = Plan.find({ isActive: true }).cursor();

  let touched = 0;
  let skipped = 0;
  let errors = 0;
  for await (const plan of cursor) {
    try {
      const lastAttempt = await DiagnosticAttempt.findOne({
        userId: plan.userId,
        status: 'completed',
      })
        .sort({ completedAt: -1 })
        .select('completedAt')
        .lean();
      if (!lastAttempt) { skipped++; continue; }
      const daysSince =
        (Date.now() - new Date(lastAttempt.completedAt).getTime()) / 86400000;
      if (daysSince < MIN_DAYS_SINCE_LAST_ATTEMPT) { skipped++; continue; }

      const signal = await computeSignal(plan.userId, sevenDaysAgo);
      if (signal < SIGNAL_THRESHOLD) { skipped++; continue; }

      const obj = await UserObjective.findById(plan.objectiveId).lean();
      if (!obj) { skipped++; continue; }

      const weeksTouched = await softRealignPlan(
        plan,
        obj.objectiveType,
        obj.specificsCanonical || obj.specifics || {}
      );
      if (weeksTouched > 0) {
        touched++;
        try {
          await notificationQueue.add('send', {
            userId: String(plan.userId),
            title: 'Your plan adapted to this week',
            body: "Tasks refreshed based on your recent progress. Open Plan to see what's new.",
            data: { type: 'plan_auto_realigned', planId: String(plan._id) },
          });
        } catch (notifErr) {
          console.warn(
            `[weeklyAutoCalibration] notification failed for ${plan._id}:`,
            notifErr.message
          );
        }
      }
    } catch (err) {
      errors++;
      console.warn(`[weeklyAutoCalibration] failed for plan ${plan._id}:`, err.message);
    }
  }
  console.log(
    `[weeklyAutoCalibration] done. touched=${touched} skipped=${skipped} errors=${errors}`
  );
  return { touched, skipped, errors };
}

module.exports = {
  runWeeklyAutoCalibration,
  _internal: {
    computeSignal,
    softRealignPlan,
    SIGNAL_THRESHOLD,
    MIN_DAYS_SINCE_LAST_ATTEMPT,
  },
};
