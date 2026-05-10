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

// Phase 6: ai_interview is now objective-level (one per week, not per topic).
// Match ANY pending ai_interview in current/future weeks — topic param is ignored
// for matching but perQuestionEval drives topicInterviewMastery updates.
async function onInterviewComplete({ userId, sessionId, topic, perQuestionEval }) {
  return withVersionRetry(
    () => Plan.findOne({ userId, isActive: true }).sort({ updatedAt: -1 }),
    async (plan) => {
      const startIdx = findCurrentWeekIndex(plan);
      if (startIdx === null) return { matched: false, reason: 'all_weeks_complete' };

      let matched = null;
      let matchedWeek = null;
      for (let i = startIdx; i < plan.weeklySchedule.length; i++) {
        const week = plan.weeklySchedule[i];
        const m = findPendingTaskInWeek(week, t => t.type === 'ai_interview');
        if (m) { matched = m; matchedWeek = week; break; }
      }
      if (!matched) return { matched: false, reason: 'no_matching_task' };

      const snap = snapshotProgress(matched);
      matched.progress.status = 'complete';
      matched.progress.completedAt = new Date();
      matched.progress.sourceEventId = String(sessionId);
      await saveWithRevert(plan, matched, snap);

      // Update topicInterviewMastery from per-question scores aggregated by concept.
      try {
        if (Array.isArray(perQuestionEval) && perQuestionEval.length > 0) {
          const KnowledgeProfile = require('../../models/KnowledgeProfile');
          const byConcept = {};
          for (const ev of perQuestionEval) {
            const c = canonicalize(ev.concept || 'general') || 'general';
            if (!byConcept[c]) byConcept[c] = { sum: 0, n: 0 };
            byConcept[c].sum += Number(ev.score) || 0;
            byConcept[c].n += 1;
          }
          const profile = await KnowledgeProfile.findOne({ userId });
          if (profile) {
            // After Mongoose load, topicInterviewMastery is a Map; .get/.set work directly.
            for (const [concept, agg] of Object.entries(byConcept)) {
              const newAvg = agg.sum / agg.n;
              const existing = (profile.topicInterviewMastery && typeof profile.topicInterviewMastery.get === 'function')
                ? profile.topicInterviewMastery.get(concept)
                : null;
              const prev = existing || { score: 0, sessions: 0, scoreHistory: [], trend: 'stable' };
              const blended = (prev.score * prev.sessions + newAvg) / (prev.sessions + 1);
              const history = (prev.scoreHistory || []).concat([{ score: newAvg, sessionId, scoredAt: new Date() }]).slice(-20);
              const trend = computeInterviewTrend(history.map(h => h.score));
              profile.topicInterviewMastery.set(concept, {
                score: blended,
                sessions: prev.sessions + 1,
                lastScoredAt: new Date(),
                trend,
                scoreHistory: history,
              });
            }
            await profile.save();
          }
        }
      } catch (err) {
        console.warn('[planProgressService] topicInterviewMastery update failed:', err.message);
      }

      return { matched: true, planId: String(plan._id), weekNumber: matchedWeek.week, taskId: String(matched._id) };
    },
  );
}

function computeInterviewTrend(scores) {
  if (!scores || scores.length < 3) return 'stable';
  const recent = scores.slice(-3);
  const earlier = scores.slice(-6, -3);
  if (earlier.length === 0) return 'stable';
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const earlierAvg = earlier.reduce((a, b) => a + b, 0) / earlier.length;
  if (recentAvg - earlierAvg > 0.5) return 'improving';
  if (earlierAvg - recentAvg > 0.5) return 'declining';
  return 'stable';
}

async function onCompetitionPlayed({ userId, challengeId, topic }) {
  const topicKey = canonicalize(topic);
  if (!topicKey) return { matched: false, reason: 'no_topic' };

  return withVersionRetry(
    () => Plan.findOne({ userId, isActive: true }).sort({ updatedAt: -1 }),
    async (plan) => {
      const startIdx = findCurrentWeekIndex(plan);
      if (startIdx === null) return { matched: false, reason: 'all_weeks_complete' };
      for (let i = startIdx; i < plan.weeklySchedule.length; i++) {
        const week = plan.weeklySchedule[i];
        const match = findPendingTaskInWeek(
          week,
          t => t.type === 'competition' && canonicalize(t.topic?.canonicalName) === topicKey,
        );
        if (match) {
          const snap = snapshotProgress(match);
          match.progress.status = 'complete';
          match.progress.completedAt = new Date();
          match.progress.sourceEventId = String(challengeId);
          await saveWithRevert(plan, match, snap);
          return { matched: true, planId: String(plan._id), weekNumber: week.week, taskId: String(match._id) };
        }
      }
      return { matched: false, reason: 'no_matching_task' };
    },
  );
}

async function markManualComplete({ userId, taskId, selfRating }) {
  const rating = Number(selfRating);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    return { matched: false, reason: 'invalid_self_rating' };
  }

  return withVersionRetry(
    () => Plan.findOne({ userId, isActive: true }).sort({ updatedAt: -1 }),
    async (plan) => {
      let foundWeek = null;
      let foundTask = null;
      for (const week of plan.weeklySchedule) {
        for (const task of (week.tasks || [])) {
          if (String(task._id) === String(taskId)) {
            foundWeek = week;
            foundTask = task;
            break;
          }
        }
        if (foundTask) break;
      }
      if (!foundTask) return { matched: false, reason: 'task_not_found' };

      const snap = snapshotProgress(foundTask);
      foundTask.progress.status = 'complete';
      foundTask.progress.completedAt = new Date();
      foundTask.progress.selfRating = rating;
      foundTask.progress.sourceEventId = `manual_${Date.now()}`;
      await saveWithRevert(plan, foundTask, snap);

      // Best-effort: update KnowledgeProfile.topicSelfRatings.
      try {
        const KnowledgeProfile = require('../../models/KnowledgeProfile');
        await KnowledgeProfile.updateOne(
          { userId },
          { $set: { [`topicSelfRatings.${foundTask.topic.canonicalName}`]: rating } },
          { upsert: true },
        );
      } catch (err) {
        console.warn('[planProgressService] KnowledgeProfile update failed:', err.message);
      }

      // For external_link tasks, also append a row to ExternalContentTouch
      // so future recalibrations know the user touched this URL.
      if (foundTask.type === 'external_link') {
        try {
          const ExternalContentTouch = require('../../models/ExternalContentTouch');
          await ExternalContentTouch.create({
            userId,
            taskId: foundTask._id,
            url: foundTask.payload?.url || '',
            title: foundTask.payload?.title || '',
            source: foundTask.payload?.source || '',
            topicCanonicalName: foundTask.topic.canonicalName,
            selfRating: rating,
            completedAt: foundTask.progress.completedAt,
          });
        } catch (err) {
          console.warn('[planProgressService] ExternalContentTouch.create failed:', err.message);
        }
      }

      return { matched: true, planId: String(plan._id), weekNumber: foundWeek.week, taskId: String(foundTask._id) };
    },
  );
}

module.exports = {
  onQuizComplete,
  onContentProgress,
  onInterviewComplete,
  onCompetitionPlayed,
  markManualComplete,
  _internal: { findCurrentWeekIndex, findPendingTaskInWeek, withVersionRetry, CONTENT_COMPLETE_THRESHOLD, MAX_RETRIES },
};
