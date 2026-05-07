/**
 * adminDigestWorker — weekly admin question review digest email.
 *
 * Runs Monday 09:00 IST (03:30 UTC on Monday = cron '30 3 * * 1').
 * Counts questions with verificationStatus='flagged_for_review', calculates
 * estimated review time at 90s per question, emails all users with role='admin'.
 * Skips if queue is empty (no nag emails).
 *
 * Dashboard URL defaults to https://api.scaleup.app/admin/dashboard.html
 * but can be overridden via ADMIN_DASHBOARD_URL env var.
 */

const User                   = require('../models/User');
const DiagnosticQuestionBank = require('../models/DiagnosticQuestionBank');
const emailService           = require('../services/emailService');

const SECONDS_PER_QUESTION = 90;
const DEFAULT_DASHBOARD_URL = 'https://api.scaleup.app/admin/dashboard.html';

async function run() {
  const queueDepth = await DiagnosticQuestionBank.countDocuments({
    verificationStatus: 'flagged_for_review',
  });

  if (queueDepth === 0) {
    console.log('[adminDigestWorker] Queue empty — skipping digest emails.');
    return { emailed: 0, queueDepth: 0 };
  }

  const estimatedMinutes = Math.ceil((queueDepth * SECONDS_PER_QUESTION) / 60);
  const dashboardUrl = process.env.ADMIN_DASHBOARD_URL || DEFAULT_DASHBOARD_URL;

  const admins = await User.find({ role: 'admin', isActive: true, isBanned: false })
    .select('email firstName')
    .lean();

  let emailed = 0;
  for (const admin of admins) {
    try {
      await emailService.sendAdminQuestionDigest(admin.email, {
        queueDepth,
        estimatedMinutes,
        dashboardUrl,
      });
      emailed++;
      console.log(`[adminDigestWorker] Digest sent to ${admin.email}`);
    } catch (err) {
      console.warn(`[adminDigestWorker] Failed to email ${admin.email}:`, err.message);
    }
  }

  console.log(`[adminDigestWorker] Digest sent to ${emailed}/${admins.length} admin(s). Queue depth: ${queueDepth}`);
  return { emailed, queueDepth };
}

module.exports = { run };
