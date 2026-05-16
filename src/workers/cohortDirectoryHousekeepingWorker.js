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

  // Retry any UserObjective rows where the pre-save canonicalizer fell
  // back (LLM unavailable, etc.) — these are flagged needsReview=true.
  // Cap at 200 per pass so a single nightly run can't blow the LLM budget.
  const topicCanonicalizationService = require('../services/topicCanonicalizationService');
  const flagged = await UserObjective.find(
    { canonicalTopic_needsReview: true, status: 'active' },
    { _id: 1, objectiveType: 1, specifics: 1, topicsOfInterest: 1 }
  ).limit(200).lean();

  let retried = 0;
  let retryResolved = 0;
  for (const obj of flagged) {
    retried++;
    const derivedRaw =
      obj.specifics?.targetRole ||
      obj.specifics?.examName ||
      obj.specifics?.targetSkill ||
      obj.specifics?.toDomain ||
      (obj.topicsOfInterest && obj.topicsOfInterest[0]) ||
      obj.objectiveType;
    try {
      const r = await topicCanonicalizationService.canonicalize(derivedRaw, obj.objectiveType);
      await UserObjective.updateOne(
        { _id: obj._id },
        {
          $set: {
            canonicalTopic: r.canonicalTopic,
            canonicalTopic_needsReview: r.source === 'fallback',
            canonicalTopic_lastResolvedAt: new Date(),
          },
        }
      );
      if (r.source !== 'fallback') retryResolved++;
    } catch (err) {
      console.warn(`[Housekeeping retry] ${obj._id} failed: ${err.message}`);
    }
  }
  if (retried > 0) {
    console.log(`[CohortDirectoryHousekeeping] retry pass: ${retryResolved}/${retried} resolved`);
  }

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
