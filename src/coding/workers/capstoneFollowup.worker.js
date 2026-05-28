'use strict';

const { Worker } = require('bullmq');
const Redis = require('ioredis');
const planIntegration = require('../services/planIntegration');
const postGrade = require('../services/capstonePostGradeNotify');
const notificationService = require('../../services/notificationService');
const { buildPayload, NOTIFICATION_TYPES } = require('../services/codingNotifications');

/**
 * Capstone follow-up worker.
 *
 * Consumes the `capstone-followup` queue. Today the only job type is
 * `send-capstone-available` — scheduled 7 days after a graded session by
 * capstonePostGradeNotify. When the job fires, we re-check eligibility
 * (in case the user changed their objective) and send the push.
 *
 * Re-check guard: if the milestone is no longer available (e.g. user
 * already started another capstone manually in the interim), we no-op.
 */

const QUEUE_NAME = 'capstone-followup';

let _conn;
function getConnection() {
  if (!_conn) _conn = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  return _conn;
}

async function processJob({ userId, gradedSessionId }) {
  const milestone = await planIntegration.getCapstoneMilestone(userId);
  if (!milestone) {
    // No-op: user is not currently eligible (probably already in-progress,
    // recently graded again, or their objective changed).
    return { skipped: 'not_eligible' };
  }
  const payload = buildPayload(NOTIFICATION_TYPES.CODING_CAPSTONE_AVAILABLE, {
    deepLink: 'scaleup://compass/coding',
    bundle_id: String(milestone.bundle_id),
    role_track: milestone.role_track,
    difficulty: milestone.difficulty,
    prior_session_id: gradedSessionId,
  });
  await notificationService.sendToUser(userId, payload);
  return { sent: true };
}

function startCapstoneFollowupWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => processJob(job.data),
    { connection: getConnection(), concurrency: 2 }
  );
  worker.on('failed', (job, err) => {
    if (job.attemptsMade >= (job.opts.attempts || 2)) {
      // eslint-disable-next-line no-console
      console.error(
        `[capstone-followup] EXHAUSTED user=${job.data.userId}:`,
        err.message
      );
    }
  });
  // Ensure the queue exists (so external callers can enqueue before the worker boots).
  postGrade._getQueue();
  return { worker };
}

module.exports = { startCapstoneFollowupWorker, QUEUE_NAME };
