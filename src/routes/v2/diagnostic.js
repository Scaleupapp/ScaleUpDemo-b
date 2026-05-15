/**
 * v2 Diagnostic routes.
 *
 * Adds:
 *   GET /api/v2/diagnostic/:attemptId/insights — v2-shaped insights including trajectory
 *
 * Reuses v1 diagnostic services and adds the trajectory + top-3 leverage actions
 * that v2's Calibration screen needs.
 */
const express = require('express');
const auth = require('../../middleware/auth');
const DiagnosticAttempt = require('../../models/DiagnosticAttempt');
const UserObjective = require('../../models/UserObjective');
const { forecastTrajectory } = require('../../services/v2/trajectoryService');

const router = express.Router();

/**
 * GET /api/v2/diagnostic/:attemptId/insights
 *
 * Returns v2 insights shape:
 *   {
 *     baseline: { readiness, headline },
 *     calibration: {
 *       selfRated:  [{ topic, level }],
 *       actual:     [{ topic, scorePct, band }],
 *       gap:        [{ topic, delta, classification }],   // overestimate / undersell
 *       summary:    "You rated yourself proficient on DP. You scored 30%. That's a significant gap."
 *     },
 *     patterns: ["You rush quant questions (...)", "You over-think case questions (...)", ...],
 *     trajectory: { today, in30Days, atTargetDate, points: [...], onTrack, headline },
 *     topActions: [
 *       { rank: 1, title: "Focus DP from foundation", reason: "highest leverage gap", action: { type: 'topic', topic: 'dp' } },
 *       ...
 *     ],
 *     planHeadline: "We've built your plan around these insights."
 *   }
 */
router.get('/:attemptId/insights', auth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const attempt = await DiagnosticAttempt.findOne({ _id: req.params.attemptId, userId });
    if (!attempt) return res.status(404).json({ success: false, message: 'Attempt not found' });

    // DiagnosticAttempt stores per-competency results in a Map (`results`)
    // and the self-rating snapshot in a Map (`selfRatings`). Normalise both
    // to plain objects so this works whether the doc is lean or hydrated.
    const resultsMap = attempt.results instanceof Map
      ? Object.fromEntries(attempt.results)
      : (attempt.results || {});
    const selfRatingsMap = attempt.selfRatings instanceof Map
      ? Object.fromEntries(attempt.selfRatings)
      : (attempt.selfRatings || {});

    // Self vs actual — keyed by competency.
    const selfRated = [];
    const actual = [];
    const gap = [];
    for (const [competency, r] of Object.entries(resultsMap)) {
      if (!r) continue;
      if (typeof r.score === 'number') {
        actual.push({ topic: competency, scorePct: Math.round(r.score), band: r.assessedBand || 'unknown' });
      }
      if (typeof r.calibrationDelta === 'number' && r.calibrationDelta !== 0) {
        // calibrationClass enum: 'well-calibrated' | 'overestimates' | 'undersells'.
        // Normalise to the singular form the v2 client expects.
        const cls = r.calibrationClass === 'overestimates'
          ? 'overestimate'
          : r.calibrationClass === 'undersells'
            ? 'undersell'
            : (r.calibrationDelta < 0 ? 'overestimate' : 'undersell');
        gap.push({ topic: competency, delta: r.calibrationDelta, classification: cls });
      }
    }
    for (const [competency, level] of Object.entries(selfRatingsMap)) {
      if (level && level !== 'unsure') selfRated.push({ topic: competency, level });
    }

    // Per-competency performance breakdown — time, accuracy, score, band —
    // so users can see HOW the readiness was computed, not just the number.
    const answers = Array.isArray(attempt.answers) ? attempt.answers : [];
    const perCompetency = new Map();
    for (const a of answers) {
      const c = a.competency;
      if (!c) continue;
      const entry = perCompetency.get(c) || {
        topic: c,
        questionsAnswered: 0,
        correct: 0,
        totalTimeSec: 0,
        hard: 0,
        hardCorrect: 0,
      };
      entry.questionsAnswered += 1;
      if (a.isCorrect) entry.correct += 1;
      entry.totalTimeSec += (a.timeTaken || 0);
      if (a.difficulty === 'hard') {
        entry.hard += 1;
        if (a.isCorrect) entry.hardCorrect += 1;
      }
      perCompetency.set(c, entry);
    }
    const performance = Array.from(perCompetency.values()).map(e => {
      const r = resultsMap[e.topic] || {};
      return {
        topic: e.topic,
        score: typeof r.score === 'number' ? Math.round(r.score) : null,
        band: r.assessedBand || null,
        accuracyPct: e.questionsAnswered ? Math.round((e.correct / e.questionsAnswered) * 100) : 0,
        avgTimeSec: e.questionsAnswered ? Math.round(e.totalTimeSec / e.questionsAnswered) : 0,
        questionsAnswered: e.questionsAnswered,
        hardAccuracyPct: e.hard ? Math.round((e.hardCorrect / e.hard) * 100) : null,
      };
    }).sort((a, b) => (a.score ?? 999) - (b.score ?? 999));

    // Patterns — derived from per-competency performance + answer telemetry.
    const patterns = [];
    if (answers.length) {
      const hard = answers.filter(a => a.difficulty === 'hard');
      const hardAcc = hard.length ? hard.filter(a => a.isCorrect).length / hard.length : null;
      const fast = answers.filter(a => (a.timeTaken || 0) > 0 && a.timeTaken < 15);
      const fastAcc = fast.length ? fast.filter(a => a.isCorrect).length / fast.length : null;
      if (fastAcc !== null && fast.length >= 3 && fastAcc < 0.5) {
        patterns.push('You move fast on questions and accuracy drops — slowing down a little would help.');
      }
      if (hardAcc !== null && hard.length >= 3 && hardAcc >= 0.6) {
        patterns.push('You hold up well on harder questions — your ceiling is higher than your average.');
      }
      // Per-competency strongest / weakest call-outs.
      const scored = performance.filter(p => p.score !== null);
      if (scored.length >= 2) {
        const best = scored.reduce((m, p) => (p.score > m.score ? p : m), scored[0]);
        const worst = scored.reduce((m, p) => (p.score < m.score ? p : m), scored[0]);
        if (best.score - worst.score >= 25) {
          patterns.push(`Strongest area: ${best.topic} (${best.score}%). Weakest: ${worst.topic} (${worst.score}%).`);
        }
      }
      // Time gap — slowest vs fastest topic by avg time.
      const timed = performance.filter(p => p.avgTimeSec > 0);
      if (timed.length >= 2) {
        const slowest = timed.reduce((m, p) => (p.avgTimeSec > m.avgTimeSec ? p : m), timed[0]);
        const fastest = timed.reduce((m, p) => (p.avgTimeSec < m.avgTimeSec ? p : m), timed[0]);
        if (slowest.avgTimeSec >= fastest.avgTimeSec * 1.8 && slowest.avgTimeSec >= 30) {
          patterns.push(`You spend much longer on ${slowest.topic} (${slowest.avgTimeSec}s avg) than on ${fastest.topic} (${fastest.avgTimeSec}s) — pacing room to gain there.`);
        }
      }
    }
    if (patterns.length === 0) {
      patterns.push('Your performance was reasonably steady across question types.');
    }

    // Baseline readiness — average of measured competency scores.
    const baselineReadiness = actual.length
      ? Math.round(actual.reduce((s, a) => s + (a.scorePct || 0), 0) / actual.length)
      : 0;

    // Trajectory — pull primary objective to forecast against
    const objective = await UserObjective.findOne({ userId, status: 'active', isPrimary: true });
    let trajectory = null;
    if (objective) {
      trajectory = forecastTrajectory({
        currentReadiness: baselineReadiness,
        objectiveType: objective.objectiveType,
        specifics: objective.specifics || {},
        timeline: objective.timeline,
        currentLevel: objective.currentLevel,
      });
    }

    // Top 3 leverage actions — highest-impact gaps. calibrationDelta is in
    // band units (-3..+3); a negative delta means the user overestimated.
    const sortedGaps = gap
      .filter(g => g.classification === 'overestimate')
      .sort((a, b) => a.delta - b.delta)
      .slice(0, 3);

    // If calibration gaps are thin, fall back to the lowest measured scores.
    const lowScoreActions = actual
      .filter(a => a.scorePct < 60)
      .sort((a, b) => a.scorePct - b.scorePct)
      .map(a => ({ topic: a.topic }));

    const gapTopics = (sortedGaps.length ? sortedGaps : lowScoreActions).slice(0, 3);
    const topActions = gapTopics.map((g, i) => {
      // Build a concrete, calculated reason so users see WHY this is on the list.
      const perf = performance.find(p => p.topic === g.topic);
      let reason = i === 0 ? 'Your highest-leverage gap' : 'A measured weak spot';
      if (perf && perf.score !== null) {
        reason = i === 0
          ? `You scored ${perf.score}% on ${g.topic} (accuracy ${perf.accuracyPct}%) — the biggest lift available.`
          : `Scored ${perf.score}% on ${g.topic}.`;
      }
      return {
        rank: i + 1,
        title: `Focus ${g.topic} from foundation`,
        reason,
        action: { type: 'topic', topic: g.topic },
      };
    });

    // Fill to 3 with generic high-leverage actions if not enough gaps
    if (topActions.length < 3) {
      const fillers = [
        { title: 'Deliberate slowdown on quantitative questions', reason: 'Read fully before picking.' },
        { title: 'Build active-recovery technique', reason: 'When you get 2 wrong in a row, pause for 30s.' },
        { title: 'Practice applied problems daily', reason: 'You’re strong on theory — application is the gap.' },
      ];
      while (topActions.length < 3 && fillers.length) {
        const f = fillers.shift();
        topActions.push({ rank: topActions.length + 1, title: f.title, reason: f.reason, action: { type: 'habit' } });
      }
    }

    // Summary sentence about the biggest overestimate.
    const striking = gap
      .filter(g => g.classification === 'overestimate')
      .sort((a, b) => a.delta - b.delta)[0];
    const calibSummary = striking
      ? `You rated yourself ${selfRated.find(s => s.topic === striking.topic)?.level || 'higher'} on ${striking.topic}, but scored ${actual.find(a => a.topic === striking.topic)?.scorePct ?? 0}% — worth a closer look.`
      : (actual.length
          ? 'You’re reasonably well-calibrated overall.'
          : 'Complete the diagnostic to see your calibration.');

    return res.json({
      success: true,
      data: {
        baseline: {
          readiness: baselineReadiness,
          headline: `Your baseline readiness: ${baselineReadiness}%`,
        },
        calibration: { selfRated, actual, gap, summary: calibSummary },
        performance,
        patterns,
        trajectory,
        topActions,
        planHeadline: 'We’ve built your plan around these insights.',
      },
    });
  } catch (err) {
    console.error('[v2/diagnostic/insights] error', err);
    return res.status(500).json({ success: false, message: 'Failed to load insights' });
  }
});

module.exports = router;
