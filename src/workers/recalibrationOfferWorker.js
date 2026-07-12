/**
 * Re-calibration Offer Worker
 *
 * Daily 04:00 IST (22:30 UTC previous day) — finds users whose latest completed
 * diagnostic attempt is >=30 days old AND who have not completed a recalibration
 * in the last 30 days, then drops an in-app recalibration_offer notification.
 *
 * No push is sent — the Progress-tab card surfaces the offer naturally next time
 * the user opens the app.
 */

const DiagnosticAttempt = require('../models/DiagnosticAttempt');
const notificationService = require('../services/notificationService');

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * @param {object} [deps] - injected-deps seam for tests (agentic-layer additions only;
 *   the pre-existing DiagnosticAttempt/notificationService require.cache stubbing seam
 *   still works unchanged since those two are imported at module scope above).
 * @param {Function} [deps.record]          - agentDecisionService.record (or stub)
 * @param {Function} [deps.isAgentEnabled]  - agentFlags.isAgentEnabled (or stub)
 */
async function run(deps = {}) {
  const record = deps.record || require('../services/agentDecisionService').record;
  const isAgentEnabled = deps.isAgentEnabled || require('../config/agentFlags').isAgentEnabled;

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - THIRTY_DAYS_MS);

  // Find users whose most recent completed attempt (any type) is >=30 days old
  const oldAttempts = await DiagnosticAttempt.aggregate([
    { $match: { status: 'completed' } },
    { $sort: { completedAt: -1 } },
    {
      $group: {
        _id: '$userId',
        latestCompletedAt: { $first: '$completedAt' },
        latestAttemptType: { $first: '$attemptType' },
      },
    },
    { $match: { latestCompletedAt: { $lte: thirtyDaysAgo } } },
  ]);

  if (oldAttempts.length === 0) return { notified: 0 };

  const userIds = oldAttempts.map(a => a._id);

  // Exclude users who already have a recent recalibration (completed within last 30 days)
  const recentRecals = await DiagnosticAttempt.find({
    userId: { $in: userIds },
    attemptType: 'recalibration',
    status: 'completed',
    completedAt: { $gte: thirtyDaysAgo },
  }).distinct('userId');

  const recentRecalSet = new Set(recentRecals.map(id => String(id)));
  const eligibleUsers = userIds.filter(id => !recentRecalSet.has(String(id)));

  // userId -> {latestCompletedAt, latestAttemptType}, for the ledger contextSnapshot.
  const attemptById = new Map(
    oldAttempts.map(a => [String(a._id), {
      latestCompletedAt: a.latestCompletedAt,
      latestAttemptType: a.latestAttemptType,
    }])
  );

  let notified = 0;
  for (const userId of eligibleUsers) {
    try {
      await notificationService.createInApp(userId, {
        type: 'recalibration_offer',
        title: "Time for a check-in?",
        message: "It's been a while since your diagnostic. Re-calibrate to see how much you've grown and get a refreshed plan.",
        deepLink: null,
      });
      notified++;

      if (isAgentEnabled('recalibration_coach')) {
        try {
          const attempt = attemptById.get(String(userId)) || {};
          await record({
            agentId: 'recalibration_coach',
            decisionType: 'nudge',
            userId,
            contextSnapshot: {
              latestCompletedAt: attempt.latestCompletedAt,
              latestAttemptType: attempt.latestAttemptType,
            },
            action: { kind: 'recalibration_offer' },
            promptVersion: 'recal-coach-v1',
          });
        } catch (err) {
          console.warn(`[recalibrationOfferWorker] ledger record failed for user ${userId}:`, err.message);
        }
      }
    } catch (err) {
      console.warn(`[recalibrationOfferWorker] notification failed for user ${userId}:`, err.message);
    }
  }

  console.log(`[recalibrationOfferWorker] Sent recalibration offers to ${notified} user(s)`);
  return { notified };
}

module.exports = { run };
