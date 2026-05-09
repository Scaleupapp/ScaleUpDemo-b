const Plan = require('../../models/Plan');

const CONTENT_COMPLETE_THRESHOLD = 80;

// Find the "current week": the smallest week index that still has any
// pending/in_progress task. If every week is fully complete, returns null.
function findCurrentWeekIndex(plan) {
  for (let i = 0; i < plan.weeklySchedule.length; i++) {
    const w = plan.weeklySchedule[i];
    if ((w.tasks || []).some(t => t.progress?.status === 'pending' || t.progress?.status === 'in_progress')) {
      return i;
    }
  }
  return null;
}

// Find the first pending task in `week` matching predicate. Returns the task
// object (mutable, since plan is a hydrated mongoose doc) or null.
function findPendingTaskInWeek(week, predicate) {
  for (const task of (week.tasks || [])) {
    if (task.progress?.status !== 'pending') continue;
    if (predicate(task)) return task;
  }
  return null;
}

async function onQuizComplete({ userId, quizId, attemptId, topic }) {
  const plan = await Plan.findOne({ userId, isActive: true }).sort({ updatedAt: -1 });
  if (!plan) return { matched: false, reason: 'no_active_plan' };

  const startIdx = findCurrentWeekIndex(plan);
  if (startIdx === null) return { matched: false, reason: 'all_weeks_complete' };

  // Search current week first, then future weeks. Never search past weeks.
  for (let i = startIdx; i < plan.weeklySchedule.length; i++) {
    const week = plan.weeklySchedule[i];
    const match = findPendingTaskInWeek(
      week,
      t => t.type === 'quiz' && t.topic?.canonicalName === topic,
    );
    if (match) {
      match.progress.status = 'complete';
      match.progress.completedAt = new Date();
      match.progress.sourceEventId = String(attemptId);
      await plan.save();
      return { matched: true, planId: String(plan._id), weekNumber: week.week, taskId: String(match._id) };
    }
  }

  return { matched: false, reason: 'no_matching_task' };
}

async function onContentProgress({ userId, contentId, percent, topic }) {
  const plan = await Plan.findOne({ userId, isActive: true }).sort({ updatedAt: -1 });
  if (!plan) return { matched: false, reason: 'no_active_plan' };

  const startIdx = findCurrentWeekIndex(plan);
  if (startIdx === null) return { matched: false, reason: 'all_weeks_complete' };

  for (let i = startIdx; i < plan.weeklySchedule.length; i++) {
    const week = plan.weeklySchedule[i];
    // Match either pending OR in_progress, since content events fire repeatedly
    const match = (week.tasks || []).find(t =>
      t.type === 'in_app_content'
      && (t.progress?.status === 'pending' || t.progress?.status === 'in_progress')
      && t.topic?.canonicalName === topic
      && String(t.payload?.contentId || '') === String(contentId)
    );
    if (!match) continue;

    if (percent >= CONTENT_COMPLETE_THRESHOLD) {
      match.progress.status = 'complete';
      match.progress.completedAt = new Date();
      match.progress.sourceEventId = String(contentId);
      await plan.save();
      return { matched: true, completed: true, planId: String(plan._id), weekNumber: week.week };
    }

    // Below threshold: bump pending -> in_progress (or leave in_progress)
    if (match.progress.status === 'pending') {
      match.progress.status = 'in_progress';
      await plan.save();
    }
    return { matched: true, completed: false, planId: String(plan._id), weekNumber: week.week };
  }

  return { matched: false, reason: 'no_matching_task' };
}

module.exports = {
  onQuizComplete,
  onContentProgress,
  _internal: { findCurrentWeekIndex, findPendingTaskInWeek, CONTENT_COMPLETE_THRESHOLD },
};
