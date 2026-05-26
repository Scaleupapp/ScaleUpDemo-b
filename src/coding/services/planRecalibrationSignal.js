'use strict';

const { DrillAttempt, MetaSkillMastery, DifficultyState } = require('../models');

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

  const attempts = await DrillAttempt.find({
    user_id: userId,
    status: 'graded',
    submitted_at: { $gte: weekStart, $lte: weekEnd },
  }).sort({ submitted_at: 1 }).lean();

  const drillCount = attempts.length;
  const scores = attempts.map(a => a.grade && a.grade.overall_score).filter(s => typeof s === 'number');
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

  const recommendedTaskMix = computeMix({ drillCount, meanScore });

  return {
    userId,
    window: { start: weekStart, end: weekEnd },
    drillCount,
    meanScore,
    trendDirection,
    metaSkillSnapshot,
    currentDifficulty,
    recommendedTaskMix,
  };
}

function computeMix({ drillCount, meanScore }) {
  // Default mix (when no drill data): drill 0, content 0.6, quiz 0.4
  if (drillCount === 0) return { drill: 0, content: 0.6, quiz: 0.4 };

  // Engaged user: scale drill weight by recent engagement (1-7 drills = 0.06-0.42, capped at 0.4)
  let drill = Math.min(0.4, drillCount * 0.06);

  // If struggling (mean < 50), lower drill weight — fundamentals first via content
  if (typeof meanScore === 'number' && meanScore < 50) drill = Math.max(0, drill - 0.1);

  // If mastering (mean > 85), nudge drill higher to keep them at edge
  if (typeof meanScore === 'number' && meanScore > 85) drill = Math.min(0.5, drill + 0.1);

  const remaining = 1 - drill;
  return { drill, content: remaining * 0.6, quiz: remaining * 0.4 };
}

module.exports = { getCodingEngagementSignal, computeMix };
