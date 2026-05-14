/**
 * Trajectory Forecast Service (v2)
 *
 * Powers the "today → 30 days → target" trajectory bar and insight reveal.
 *
 * Inputs: current readiness (0-100), committed weekly hours, timeline weeks
 * Output: forecast for 30/60/90 days + projected reach by target date
 *
 * Model (v0 — simple monotonic catch-up; refine with outcome data later):
 *   readiness_t = current + (gap × min(1, (hours_invested / hours_needed)))
 *
 * Where gap = 80 - current (target band is 80%+ readiness).
 * Hours_needed comes from requiredTimeService for the same objective.
 *
 * Assumes user delivers committed hours. Real plan adapter (v1 journeyAdapter)
 * recalibrates if actual deviates.
 */

const { computeRequiredTime } = require('./requiredTimeService');

const TARGET_READINESS = 80; // band where outcome probability becomes meaningful

/**
 * Project readiness at horizon weeks from now, given hours/week commitment.
 */
function projectReadiness({ currentReadiness, hoursPerWeek, hoursTotalNeeded, weeksElapsed }) {
  const hoursInvested = hoursPerWeek * weeksElapsed;
  const fractionDone  = Math.min(1, hoursInvested / Math.max(1, hoursTotalNeeded));
  const gap = Math.max(0, TARGET_READINESS - currentReadiness);
  const overshoot = currentReadiness >= TARGET_READINESS ? 0.05 * weeksElapsed : 0; // slow grind above 80
  return Math.min(95, Math.round(currentReadiness + gap * fractionDone + overshoot));
}

/**
 * Forecast for a primary objective.
 *
 * @param {Object} args
 * @param {Number} args.currentReadiness  - 0-100 (e.g., baseline from diagnostic, or current)
 * @param {String} args.objectiveType
 * @param {Object} args.specifics
 * @param {String} args.timeline
 * @param {String} args.currentLevel
 *
 * @returns {Object} { today, in30Days, in60Days, in90Days, atTargetDate, weeklyDelta, onTrack }
 */
function forecastTrajectory({ currentReadiness, objectiveType, specifics, timeline, currentLevel = 'beginner' }) {
  const required = computeRequiredTime({ objectiveType, specifics, timeline, currentLevel });

  const baseline = Math.max(0, Math.min(100, currentReadiness ?? 0));
  const hoursPerWeek = required.requiredHoursPerWeek;
  const hoursTotalNeeded = required.totalHoursRemaining;
  const timelineWeeks = required.timelineWeeks;

  const at = (weeks) => projectReadiness({ currentReadiness: baseline, hoursPerWeek, hoursTotalNeeded, weeksElapsed: weeks });

  const today = baseline;
  const in30Days  = at(4);
  const in60Days  = at(8);
  const in90Days  = at(13);
  const atTargetDate = at(timelineWeeks);

  const weeklyDelta = Math.max(1, Math.round((TARGET_READINESS - baseline) / Math.max(1, timelineWeeks)));
  const onTrack = atTargetDate >= TARGET_READINESS;

  return {
    today,
    in30Days,
    in60Days,
    in90Days,
    atTargetDate,
    targetReadiness: TARGET_READINESS,
    timelineWeeks,
    weeklyDelta,
    onTrack,
    points: [
      { whenLabel: 'Today',         readiness: today,         weeks: 0 },
      { whenLabel: '30 days',       readiness: in30Days,      weeks: 4 },
      { whenLabel: '60 days',       readiness: in60Days,      weeks: 8 },
      { whenLabel: '90 days',       readiness: in90Days,      weeks: 13 },
      { whenLabel: 'Target',        readiness: atTargetDate,  weeks: timelineWeeks },
    ],
    headline: onTrack
      ? `You can reach ~${atTargetDate}% readiness by your target. On track.`
      : `At current pace you'd reach ~${atTargetDate}% by target. Below the ${TARGET_READINESS}% line.`,
  };
}

module.exports = {
  forecastTrajectory,
  _internal: { projectReadiness, TARGET_READINESS },
};
