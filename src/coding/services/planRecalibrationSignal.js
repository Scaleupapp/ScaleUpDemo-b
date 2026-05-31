'use strict';

const { DrillAttempt, MetaSkillMastery, DifficultyState, CapstoneSession } = require('../models');

/**
 * Recalibration signal contribution from drills.
 *
 * Output shape (additive — designed to plug into a future Plan recalibration aggregator):
 *
 * {
 *   userId,
 *   window: { start, end },
 *   drillCount: <number>,
 *   meanScore: <0-100 or null>,
 *   trendDirection: 'up' | 'down' | 'flat' | 'insufficient',
 *   metaSkillSnapshot: { prompting, verification, decomposition, refactoring },
 *   currentDifficulty: 'easy' | 'medium' | 'hard' | null,
 *   recommendedTaskMix: { drill: 0-1, content: 0-1, quiz: 0-1 }  // suggested weighting for next week's mix
 * }
 *
 * trendDirection rules:
 *   - 'insufficient' if < 3 graded drills in window
 *   - 'up' if last-half mean > first-half mean by > 5 points
 *   - 'down' if last-half mean < first-half mean by > 5 points
 *   - 'flat' otherwise
 *
 * recommendedTaskMix logic:
 *   - drill weight scales with how engaged the user has been; if they did 0 drills, weight is 0
 *   - if mean score < 50, lower drill weight (don't pile more on a struggling axis)
 *   - if mean score > 85, suggest leaning into capstones / harder content (signal future Phase B)
 */
async function getCodingEngagementSignal({ userId, weekStart, weekEnd, role_track } = {}) {
  if (!userId) throw new Error('userId required');
  if (!weekStart || !weekEnd) throw new Error('weekStart and weekEnd required');

  // Coding engagement spans BOTH drills and capstones (the learner asked for
  // both to feed recalibration). We merge them into one chronological score
  // series for trend/mean, and report counts separately.
  const [attempts, capstones] = await Promise.all([
    DrillAttempt.find({
      user_id: userId,
      status: 'graded',
      submitted_at: { $gte: weekStart, $lte: weekEnd },
    }).sort({ submitted_at: 1 }).lean(),
    CapstoneSession.find({
      user_id: userId,
      status: 'graded',
      graded_at: { $gte: weekStart, $lte: weekEnd },
    }).sort({ graded_at: 1 }).lean(),
  ]);

  const drillCount = attempts.length;
  const capstoneCount = capstones.length;
  // Build a single time-ordered series of 0-100 scores across drills + capstones.
  const series = [
    ...attempts.map(a => ({ at: a.submitted_at, score: a.grade && a.grade.overall_score })),
    ...capstones.map(c => ({ at: c.graded_at, score: c.result && c.result.overall_score })),
  ]
    .filter(x => typeof x.score === 'number')
    .sort((a, b) => new Date(a.at) - new Date(b.at));
  const scores = series.map(x => x.score);
  const meanScore = scores.length === 0 ? null : (scores.reduce((s, v) => s + v, 0) / scores.length);

  let trendDirection = 'insufficient';
  if (scores.length >= 3) {
    const half = Math.floor(scores.length / 2);
    const firstMean = scores.slice(0, half).reduce((s, v) => s + v, 0) / half;
    const lastMean = scores.slice(half).reduce((s, v) => s + v, 0) / (scores.length - half);
    if (lastMean - firstMean > 5) trendDirection = 'up';
    else if (firstMean - lastMean > 5) trendDirection = 'down';
    else trendDirection = 'flat';
  }

  let metaSkillSnapshot = null;
  let currentDifficulty = null;
  if (role_track) {
    const mastery = await MetaSkillMastery.findOne({ user_id: userId, role_track }).lean();
    metaSkillSnapshot = mastery
      ? mastery.axes
      : { prompting: 0, verification: 0, decomposition: 0, refactoring: 0 };
    const diff = await DifficultyState.findOne({ user_id: userId, role_track }).lean();
    currentDifficulty = diff ? diff.current_difficulty : null;
  }

  const recommendedTaskMix = computeMix({ activityCount: drillCount + capstoneCount, meanScore });

  return {
    userId,
    window: { start: weekStart, end: weekEnd },
    drillCount,
    capstoneCount,
    meanScore,
    trendDirection,
    metaSkillSnapshot,
    currentDifficulty,
    recommendedTaskMix,
  };
}

function computeMix({ activityCount, meanScore }) {
  // Default mix (when no coding data): drill 0, content 0.6, quiz 0.4
  if (!activityCount) return { drill: 0, content: 0.6, quiz: 0.4 };

  // Engaged user: scale drill weight by recent coding engagement (drills +
  // capstones; 1-7 = 0.06-0.42, capped at 0.4)
  let drill = Math.min(0.4, activityCount * 0.06);

  // If struggling (mean < 50), lower drill weight — fundamentals first via content
  if (typeof meanScore === 'number' && meanScore < 50) drill = Math.max(0, drill - 0.1);

  // If mastering (mean > 85), nudge drill higher to keep them at edge
  if (typeof meanScore === 'number' && meanScore > 85) drill = Math.min(0.5, drill + 0.1);

  const remaining = 1 - drill;
  return { drill, content: remaining * 0.6, quiz: remaining * 0.4 };
}

module.exports = { getCodingEngagementSignal, computeMix };
