/**
 * Re-calibration Eligibility Service
 *
 * Per spec §3.5: identifies which topics are eligible for re-calibration.
 * A topic qualifies if the user has:
 *   1. Spent ≥5 plan hours on it since the last diagnostic, OR
 *   2. Self-flagged "I've grown here" (userFlaggedTopics), OR
 *   3. It is the topic with the largest original calibration gap (always included).
 *
 * Returns {eligible:false, reason} when the cooldown hasn't passed,
 * otherwise {eligible:true, eligibleTopics, expectedDurationMin, previousAttemptId}.
 * Caps eligible topics at 6 (~12 questions / 4–5 min).
 */

const DiagnosticAttempt = require('../../models/DiagnosticAttempt');
const Plan = require('../../models/Plan');

const MIN_DAYS_SINCE_LAST = 30;
const MIN_HOURS_ON_TOPIC = 5;
const MAX_ELIGIBLE_TOPICS = 6;
const QUESTIONS_PER_TOPIC = 2;
const SECONDS_PER_QUESTION = 25;

async function computeEligibility(userId, opts = {}) {
  const userFlaggedTopics = opts.userFlaggedTopics || [];

  // Find the most recent completed attempt (initial or recalibration)
  const lastAttempt = await DiagnosticAttempt.findOne(
    { userId, status: 'completed' },
    null,
    { sort: { completedAt: -1 } },
  ).lean();

  if (!lastAttempt) {
    return { eligible: false, reason: 'no_completed_attempt' };
  }

  const daysSinceLast = (Date.now() - new Date(lastAttempt.completedAt).getTime()) / 86400000;
  if (daysSinceLast < MIN_DAYS_SINCE_LAST) {
    return {
      eligible: false,
      reason: 'too_recent',
      daysSinceLast: Math.floor(daysSinceLast),
      minDaysRequired: MIN_DAYS_SINCE_LAST,
    };
  }

  // Build topic list from the last attempt's results
  const topics = [];
  for (const [canonicalName, r] of (lastAttempt.results instanceof Map
    ? lastAttempt.results.entries()
    : Object.entries(lastAttempt.results || {}))) {
    topics.push({
      canonicalName,
      score: r.score || 0,
      calibrationDelta: r.calibrationDelta || 0,
    });
  }

  if (topics.length === 0) {
    return { eligible: false, reason: 'no_results_in_attempt' };
  }

  // Identify the topic with the largest |calibrationDelta| — always included
  const biggestGapTopic = topics.reduce(
    (best, t) => Math.abs(t.calibrationDelta) > Math.abs(best.calibrationDelta) ? t : best,
    topics[0],
  );

  // Get hours spent per topic from the active plan since the last attempt
  const activePlan = await Plan.findOne(
    { userId, isActive: true },
  ).lean();

  // Lazy require so tests can stub via require.cache
  const journeyProgressService = require('../journeyProgressService');
  let hoursPerTopic = {};
  if (activePlan && typeof journeyProgressService.getHoursSpentByTopic === 'function') {
    try {
      hoursPerTopic = await journeyProgressService.getHoursSpentByTopic(
        userId,
        activePlan._id,
        lastAttempt.completedAt,
      );
    } catch (_) {
      // Non-fatal — degrade gracefully to no hours signal
    }
  }

  // Score each topic
  const scored = topics.map(t => {
    const hours = hoursPerTopic[t.canonicalName] || 0;
    const isBiggestGap = t.canonicalName === biggestGapTopic.canonicalName;
    const isFlagged = userFlaggedTopics.includes(t.canonicalName);
    const hasEnoughHours = hours >= MIN_HOURS_ON_TOPIC;
    const qualifies = isBiggestGap || isFlagged || hasEnoughHours;
    return { ...t, hours, isBiggestGap, isFlagged, hasEnoughHours, qualifies };
  });

  // Sort: biggest gap first, then flagged, then hours desc
  const eligible = scored
    .filter(t => t.qualifies)
    .sort((a, b) => {
      if (a.isBiggestGap !== b.isBiggestGap) return a.isBiggestGap ? -1 : 1;
      if (a.isFlagged !== b.isFlagged) return a.isFlagged ? -1 : 1;
      return b.hours - a.hours;
    })
    .slice(0, MAX_ELIGIBLE_TOPICS);

  if (eligible.length === 0) {
    return { eligible: false, reason: 'no_eligible_topics' };
  }

  const totalQuestions = eligible.length * QUESTIONS_PER_TOPIC;
  const expectedDurationMin = Math.ceil((totalQuestions * SECONDS_PER_QUESTION) / 60);

  return {
    eligible: true,
    eligibleTopics: eligible.map(t => t.canonicalName),
    expectedDurationMin,
    previousAttemptId: String(lastAttempt._id),
    topicDetails: eligible.map(t => ({
      canonicalName: t.canonicalName,
      reason: t.isBiggestGap ? 'biggest_gap' : t.isFlagged ? 'user_flagged' : 'hours_spent',
      hours: t.hours,
    })),
  };
}

module.exports = { computeEligibility };
