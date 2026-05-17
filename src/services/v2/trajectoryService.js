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
 * @param {String} [args.userId]          - optional; enables velocity measurement
 * @param {Object} [args.plan]            - optional; the user's active Plan doc (in-memory)
 *
 * @returns {Object} { today, in30Days, in60Days, in90Days, atTargetDate, weeklyDelta,
 *                     onTrack, velocitySource, realTasksPerWeek, points, headline }
 */
function forecastTrajectory({ currentReadiness, objectiveType, specifics, timeline, currentLevel = 'beginner', userId, plan }) {
  const required = computeRequiredTime({ objectiveType, specifics, timeline, currentLevel });

  const baseline = Math.max(0, Math.min(100, currentReadiness ?? 0));
  const timelineWeeks = required.timelineWeeks;

  // Static fallback delta — how many readiness % points per week if we have
  // no measured pace yet. Derived from the hours-based model:
  // gap / timelineWeeks, floored at 1.
  const staticDelta = Math.max(1, Math.round((TARGET_READINESS - baseline) / Math.max(1, timelineWeeks)));

  // ── Velocity measurement ─────────────────────────────────────────────────
  // Walk the in-memory plan doc (no extra DB hit) and count tasks completed
  // in the last 28 days. If there are >=7 we have a meaningful sample.
  let realDelta = null;
  let velocitySource = 'estimated';
  let realTasksPerWeek = null;

  if (userId && plan && Array.isArray(plan.weeklySchedule)) {
    const FOUR_WEEKS_MS = 28 * 24 * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - FOUR_WEEKS_MS);

    const completed = plan.weeklySchedule
      .flatMap(w => w.tasks || [])
      .filter(t =>
        t.progress?.status === 'complete' &&
        t.progress?.completedAt &&
        new Date(t.progress.completedAt) >= cutoff
      );

    if (completed.length >= 7) {
      const tasksPerWk = completed.length / 4; // spread over 4 calendar weeks
      // Calibration: 1 completed task ≈ 1% readiness gain per week on average.
      // Floor at 0.5 so the curve never looks flat/discouraging.
      realDelta = Math.max(0.5, tasksPerWk * 1.0);
      velocitySource = 'measured';
      realTasksPerWeek = Math.round(tasksPerWk * 10) / 10;
    }
  }

  const effectiveDelta = realDelta !== null ? realDelta : staticDelta;

  // ── Pace classification + ETA fields ────────────────────────────────────
  const paceCategory =
    effectiveDelta >= staticDelta * 1.5 ? 'ahead' :
    effectiveDelta < staticDelta * 0.8  ? 'behind' :
    'on_track';

  const weeksToTarget = effectiveDelta > 0
    ? Math.min(999, Math.ceil((TARGET_READINESS - baseline) / effectiveDelta))
    : 999;

  const projectedTargetDate = weeksToTarget < 999
    ? new Date(Date.now() + weeksToTarget * 7 * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const earlyByWeeks = (paceCategory === 'ahead' && timelineWeeks > 0)
    ? Math.max(0, timelineWeeks - weeksToTarget)
    : null;

  const targetHit = baseline >= TARGET_READINESS;

  // Deadline-relative ETA. If the projected weeksToTarget exceeds the user's
  // chosen timeline, surface that gap so the UI can say "X weeks past your
  // deadline" instead of an unbounded "in 25 weeks".
  const projectedAfterDeadline = !targetHit && weeksToTarget > timelineWeeks;
  const weeksLateVsDeadline = projectedAfterDeadline
    ? weeksToTarget - timelineWeeks
    : null;

  // ── Forecast curve ───────────────────────────────────────────────────────
  // Build readiness at each horizon from the effective weekly delta,
  // capped at TARGET_READINESS so we never promise more than the goal.
  const project = (weeks) =>
    Math.min(TARGET_READINESS, Math.round(baseline + effectiveDelta * weeks));

  const today        = baseline;
  const in30Days     = project(4);
  const in60Days     = project(8);
  const in90Days     = project(12);
  const atTargetDate = project(timelineWeeks);

  const weeklyDelta = Math.round(effectiveDelta * 10) / 10;
  const onTrack = effectiveDelta >= staticDelta * 0.8;

  // ── Timeline-aware chart points ──────────────────────────────────────────
  // For short timelines (1mo, 3mo) the 30/60/90-day curve runs WAY past the
  // user's deadline and confuses the story ("why am I seeing 90 days when my
  // plan is 4 weeks?"). So we scale the horizons to the actual timeline:
  //   ≤6 weeks  → Today + weekly milestones up to the target date
  //   7-12 wks  → Today + midpoint + target date
  //   >12 wks   → keep the existing 30/60/90 view (still under the deadline)
  let points;
  if (timelineWeeks > 0 && timelineWeeks <= 6) {
    points = [{ whenLabel: 'Today', readiness: today, weeks: 0 }];
    for (let w = 1; w <= timelineWeeks; w++) {
      const label = w === timelineWeeks ? 'Target' : `Wk ${w}`;
      points.push({ whenLabel: label, readiness: project(w), weeks: w });
    }
  } else if (timelineWeeks > 6 && timelineWeeks <= 12) {
    const mid = Math.round(timelineWeeks / 2);
    points = [
      { whenLabel: 'Today',           readiness: today,             weeks: 0 },
      { whenLabel: `Wk ${mid}`,       readiness: project(mid),      weeks: mid },
      { whenLabel: 'Target',          readiness: project(timelineWeeks), weeks: timelineWeeks },
    ];
  } else {
    points = [
      { whenLabel: 'Today',   readiness: today,    weeks: 0 },
      { whenLabel: '30 days', readiness: in30Days, weeks: 4 },
      { whenLabel: '60 days', readiness: in60Days, weeks: 8 },
      { whenLabel: '90 days', readiness: in90Days, weeks: 12 },
    ];
  }
  points.sort((a, b) => a.weeks - b.weeks);

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
    velocitySource,
    realTasksPerWeek,
    points,
    headline: onTrack
      ? `You can reach ~${atTargetDate}% readiness by your target. On track.`
      : `At current pace you'd reach ~${atTargetDate}% by target. Below the ${TARGET_READINESS}% line.`,
    // ── Adaptive ETA fields (v2) ──────────────────────────────────────────
    paceCategory,
    weeksToTarget,
    projectedTargetDate,
    earlyByWeeks,
    targetHit,
    projectedAfterDeadline,
    weeksLateVsDeadline,
  };
}

module.exports = {
  forecastTrajectory,
  _internal: { projectReadiness, TARGET_READINESS },
};
