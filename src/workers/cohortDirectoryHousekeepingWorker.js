/**
 * Nightly drift-correction for CohortDirectory.
 *
 * - Recomputes memberCount from UserObjective (active+primary, by canonicalTopic).
 * - Recomputes weeklyAttempts from ChallengeAttempt (last 7 days, joined via DailyChallenge.topic).
 * - Refreshes historicalStats from a 30-day attempt aggregate.
 * - Marks isActive=false for cohorts with no attempts and no members for 30 days;
 *   reactivates anything with a fresh member or attempt.
 */
const UserObjective = require('../models/UserObjective');
const ChallengeAttempt = require('../models/ChallengeAttempt');
const CohortDirectory = require('../models/CohortDirectory');

const DAY_MS = 24 * 60 * 60 * 1000;

async function run() {
  const t0 = Date.now();

  const memberAgg = await UserObjective.aggregate([
    { $match: { status: 'active', isPrimary: true, canonicalTopic: { $exists: true, $ne: null, $ne: '' } } },
    { $group: { _id: '$canonicalTopic', count: { $sum: 1 } } },
  ]);
  const memberMap = new Map(memberAgg.map(g => [g._id, g.count]));

  const weekAgo = new Date(Date.now() - 7 * DAY_MS);
  const monthAgo = new Date(Date.now() - 30 * DAY_MS);

  const weeklyAgg = await ChallengeAttempt.aggregate([
    { $match: { completedAt: { $gte: weekAgo } } },
    { $lookup: { from: 'dailychallenges', localField: 'challengeId', foreignField: '_id', as: 'challenge' } },
    { $unwind: '$challenge' },
    { $group: { _id: '$challenge.topic', count: { $sum: 1 } } },
  ]);
  const weeklyMap = new Map(weeklyAgg.map(g => [g._id, g.count]));

  const statsAgg = await ChallengeAttempt.aggregate([
    { $match: { completedAt: { $gte: monthAgo }, handicappedScore: { $exists: true } } },
    { $lookup: { from: 'dailychallenges', localField: 'challengeId', foreignField: '_id', as: 'challenge' } },
    { $unwind: '$challenge' },
    { $group: { _id: '$challenge.topic', scores: { $push: '$handicappedScore' } } },
  ]);
  const statsMap = new Map();
  for (const s of statsAgg) {
    const sorted = [...s.scores].sort((a, b) => a - b);
    const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    const p90 = sorted[Math.floor(sorted.length * 0.9)] || sorted[sorted.length - 1] || 0;
    statsMap.set(s._id, { avg: Math.round(avg), p90: Math.round(p90), sampleSize: sorted.length });
  }

  const allCohorts = await CohortDirectory.find({}).lean();
  let updated = 0;
  for (const c of allCohorts) {
    const newMembers = memberMap.get(c.canonicalTopic) || 0;
    const newWeekly = weeklyMap.get(c.canonicalTopic) || 0;
    const stats = statsMap.get(c.canonicalTopic);
    const noActivity = newMembers === 0 && newWeekly === 0 && (!c.lastAttemptAt || c.lastAttemptAt < monthAgo);

    const setObj = {
      memberCount: newMembers,
      weeklyAttempts: newWeekly,
      isActive: !noActivity,
    };
    if (stats) {
      setObj.historicalStats = {
        last30dAverageScore: stats.avg,
        last30dP90Score: stats.p90,
        sampleSize: stats.sampleSize,
        refreshedAt: new Date(),
      };
    }
    await CohortDirectory.updateOne({ _id: c._id }, { $set: setObj });
    updated++;
  }

  console.log(`[CohortDirectoryHousekeeping] updated=${updated} elapsedMs=${Date.now() - t0}`);
}

module.exports = { run };
