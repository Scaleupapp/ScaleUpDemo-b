const Plan = require('../../models/Plan');
const { canonicalize } = require('../diagnostic/topicTaxonomyService');

const CONTENT_COMPLETE_THRESHOLD = 80;
const MAX_RETRIES = 3;

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

// Save with optimistic-concurrency revert. Snapshots the task's progress
// before save; on VersionError restores it (so a retried load that returns
// the same in-memory doc sees the task as still pending) and re-throws.
// In production the retry's loadFn fetches a fresh doc from the DB, so the
// restore is moot — but keeping the in-memory doc clean prevents the second
// attempt from operating on a half-mutated doc if loadFn ever returns the
// same reference.
async function saveWithRevert(plan, task, snapshot) {
  try {
    await plan.save();
  } catch (err) {
    if (err && err.name === 'VersionError') {
      task.progress = snapshot;
    }
    throw err;
  }
}

function snapshotProgress(task) {
  // Shallow clone is sufficient — progress fields are primitives + Date.
  return { ...(task.progress || {}) };
}

// Wraps a load-then-apply sequence with optimistic-concurrency retry. If
// `applyFn` throws a Mongoose VersionError (because another writer bumped
// __v on the same Plan doc between our load and save), re-load the plan and
// re-run apply up to MAX_RETRIES total attempts. After that, give up and
// return { matched: false, reason: 'concurrent_update' } so the caller knows
// the event wasn't applied (instead of silently swallowing the error).
async function withVersionRetry(loadFn, applyFn) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const plan = await loadFn();
    if (!plan) return { matched: false, reason: 'no_active_plan' };
    try {
      return await applyFn(plan);
    } catch (err) {
      if (err && err.name === 'VersionError') {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  return { matched: false, reason: 'concurrent_update', error: lastErr?.message };
}

async function onQuizComplete({ userId, quizId, attemptId, topic }) {
  const topicKey = canonicalize(topic);
  if (!topicKey) return { matched: false, reason: 'no_topic' };

  return withVersionRetry(
    () => Plan.findOne({ userId, isActive: true }).sort({ updatedAt: -1 }),
    async (plan) => {
      const startIdx = findCurrentWeekIndex(plan);
      if (startIdx === null) return { matched: false, reason: 'all_weeks_complete' };

      // Search current week first, then future weeks. Never search past weeks.
      for (let i = startIdx; i < plan.weeklySchedule.length; i++) {
        const week = plan.weeklySchedule[i];
        const match = findPendingTaskInWeek(
          week,
          t => t.type === 'quiz' && canonicalize(t.topic?.canonicalName) === topicKey,
        );
        if (match) {
          const snap = snapshotProgress(match);
          match.progress.status = 'complete';
          match.progress.completedAt = new Date();
          match.progress.sourceEventId = String(attemptId);
          await saveWithRevert(plan, match, snap); // VersionError → revert + re-throw → retried by withVersionRetry
          return { matched: true, planId: String(plan._id), weekNumber: week.week, taskId: String(match._id) };
        }
      }

      return { matched: false, reason: 'no_matching_task' };
    },
  );
}

async function onContentProgress({ userId, contentId, percent, topic }) {
  const topicKey = canonicalize(topic);
  if (!topicKey) return { matched: false, reason: 'no_topic' };

  return withVersionRetry(
    () => Plan.findOne({ userId, isActive: true }).sort({ updatedAt: -1 }),
    async (plan) => {
      const startIdx = findCurrentWeekIndex(plan);
      if (startIdx === null) return { matched: false, reason: 'all_weeks_complete' };

      for (let i = startIdx; i < plan.weeklySchedule.length; i++) {
        const week = plan.weeklySchedule[i];
        // Match either pending OR in_progress, since content events fire repeatedly
        const match = (week.tasks || []).find(t =>
          t.type === 'in_app_content'
          && (t.progress?.status === 'pending' || t.progress?.status === 'in_progress')
          && canonicalize(t.topic?.canonicalName) === topicKey
          && String(t.payload?.contentId || '') === String(contentId)
        );
        if (!match) continue;

        if (percent >= CONTENT_COMPLETE_THRESHOLD) {
          const snap = snapshotProgress(match);
          match.progress.status = 'complete';
          match.progress.completedAt = new Date();
          match.progress.sourceEventId = String(contentId);
          await saveWithRevert(plan, match, snap); // VersionError → revert + re-throw → retried by withVersionRetry
          return { matched: true, completed: true, planId: String(plan._id), weekNumber: week.week };
        }

        // Below threshold: bump pending -> in_progress (or leave in_progress)
        if (match.progress.status === 'pending') {
          const snap = snapshotProgress(match);
          match.progress.status = 'in_progress';
          await saveWithRevert(plan, match, snap); // VersionError → revert + re-throw → retried by withVersionRetry
        }
        return { matched: true, completed: false, planId: String(plan._id), weekNumber: week.week };
      }

      return { matched: false, reason: 'no_matching_task' };
    },
  );
}

module.exports = {
  onQuizComplete,
  onContentProgress,
  _internal: { findCurrentWeekIndex, findPendingTaskInWeek, withVersionRetry, CONTENT_COMPLETE_THRESHOLD, MAX_RETRIES },
};
