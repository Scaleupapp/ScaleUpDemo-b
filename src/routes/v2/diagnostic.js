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

    const topicResults = Array.isArray(attempt.topicResults) ? attempt.topicResults : [];

    // Self vs actual
    const selfRated = [];
    const actual = [];
    const gap = [];
    for (const t of topicResults) {
      const name = t.canonicalName || t.name || 'topic';
      if (t.selfRating) selfRated.push({ topic: name, level: t.selfRating });
      if (typeof t.measuredScore === 'number') {
        actual.push({ topic: name, scorePct: t.measuredScore, band: t.measuredBand || 'unknown' });
      }
      if (typeof t.calibrationDelta === 'number') {
        gap.push({
          topic: name,
          delta: t.calibrationDelta,
          classification: t.calibrationClass || (t.calibrationDelta < 0 ? 'overestimate' : 'undersell'),
        });
      }
    }

    // Patterns — pulled from cognitive fingerprint if available
    const patterns = [];
    if (attempt.cognitiveSignals) {
      const cs = attempt.cognitiveSignals;
      if (cs.rushesOnQuant) patterns.push('You rush quantitative questions — your accuracy drops when you move fast.');
      if (cs.overThinksCases) patterns.push('You over-think case questions — accuracy holds but time pressure may hurt you in real interviews.');
      if (cs.chokingAfterMisses) patterns.push('After 2 wrong in a row, your next answers are 60% likely to be wrong. Build an active recovery technique.');
      if (cs.strongOnConceptual) patterns.push('You’re consistently strong on conceptual recall, weaker on applied problems.');
    }
    if (patterns.length === 0) {
      patterns.push('Your performance was reasonably steady across question types.');
    }

    // Baseline readiness — from attempt results or default
    const baselineReadiness =
      attempt.computedReadiness ??
      attempt.aggregateScore ??
      Math.round(actual.reduce((s, a) => s + (a.scorePct || 0), 0) / Math.max(1, actual.length));

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

    // Top 3 leverage actions — highest-impact gaps
    const sortedGaps = gap
      .filter(g => g.classification === 'overestimate' || g.delta < -10)
      .sort((a, b) => a.delta - b.delta)
      .slice(0, 3);

    const topActions = sortedGaps.map((g, i) => ({
      rank: i + 1,
      title: `Focus ${g.topic} from foundation`,
      reason: i === 0 ? 'Your highest-leverage gap' : `Calibration gap of ${Math.abs(g.delta)} pts`,
      action: { type: 'topic', topic: g.topic },
    }));

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

    // Summary sentence about the biggest gap
    const striking = gap.sort((a, b) => a.delta - b.delta)[0];
    const calibSummary = striking && striking.delta < -10
      ? `You rated yourself ${selfRated.find(s => s.topic === striking.topic)?.level || 'higher'} on ${striking.topic}. You scored ${actual.find(a => a.topic === striking.topic)?.scorePct || 0}%. That's a significant gap.`
      : 'You’re reasonably well-calibrated overall.';

    return res.json({
      success: true,
      data: {
        baseline: {
          readiness: baselineReadiness,
          headline: `Your baseline readiness: ${baselineReadiness}%`,
        },
        calibration: { selfRated, actual, gap, summary: calibSummary },
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
