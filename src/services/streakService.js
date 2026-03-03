const Journey = require('../models/Journey');
const ContentProgress = require('../models/ContentProgress');

/**
 * Returns the start of a given date (midnight UTC).
 */
function startOfDayUTC(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Checks whether the user completed any content on a given UTC date.
 */
async function hadActivityOn(userId, date) {
  const dayStart = startOfDayUTC(date);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  const count = await ContentProgress.countDocuments({
    userId,
    isCompleted: true,
    completedAt: { $gte: dayStart, $lt: dayEnd },
  });
  return count > 0;
}

/**
 * Computes the actual consecutive-day streak by walking backward from today.
 * Idempotent — safe to call multiple times per day.
 */
async function computeStreak(userId) {
  let streak = 0;
  let checkDate = startOfDayUTC(new Date());

  while (true) {
    const active = await hadActivityOn(userId, checkDate);
    if (!active) break;
    streak++;
    checkDate.setUTCDate(checkDate.getUTCDate() - 1);
    if (streak > 365) break;
  }

  return streak;
}

/**
 * Persists streak via atomic $set — avoids full-document validation
 * which can fail on raw-inserted documents with nested subdocuments.
 */
async function persistStreak(journeyId, currentStreak, longestStreak) {
  const update = { 'progress.currentStreak': currentStreak };
  if (longestStreak !== undefined) {
    update['progress.longestStreak'] = longestStreak;
  }
  await Journey.updateOne({ _id: journeyId }, { $set: update });
}

/**
 * Called after content completion or assignment completion.
 * Recomputes the streak from scratch so it's always accurate.
 */
async function updateStreak(userId) {
  const journey = await Journey.findOne({ userId, status: 'active' }).select('_id progress').lean();
  if (!journey) return;

  const newStreak = await computeStreak(userId);
  const longestStreak = Math.max(newStreak, journey.progress.longestStreak || 0);
  await persistStreak(journey._id, newStreak, longestStreak);
}

/**
 * Called by the daily cron job. Recomputes streaks for all active journeys.
 */
async function resetStaleStreaks() {
  const journeys = await Journey.find({
    status: 'active',
    'progress.currentStreak': { $gt: 0 },
  }).select('_id userId progress').lean();

  let resetCount = 0;
  for (const journey of journeys) {
    const newStreak = await computeStreak(journey.userId);
    if (newStreak !== journey.progress.currentStreak) {
      const longestStreak = Math.max(newStreak, journey.progress.longestStreak || 0);
      await persistStreak(journey._id, newStreak, longestStreak);
      if (newStreak === 0) resetCount++;
    }
  }

  if (resetCount > 0) {
    console.log(`[streakService] Reset ${resetCount} stale streak(s)`);
  }
}

/**
 * Lazy streak check — called on dashboard load. Recomputes if stale.
 */
async function ensureStreakFresh(userId) {
  const journey = await Journey.findOne({ userId, status: 'active' }).select('_id progress').lean();
  if (!journey) return;

  const newStreak = await computeStreak(userId);
  if (newStreak !== journey.progress.currentStreak) {
    const longestStreak = Math.max(newStreak, journey.progress.longestStreak || 0);
    await persistStreak(journey._id, newStreak, longestStreak);
  }
}

module.exports = { updateStreak, resetStaleStreaks, ensureStreakFresh };
