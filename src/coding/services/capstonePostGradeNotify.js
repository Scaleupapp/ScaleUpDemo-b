'use strict';

/**
 * capstonePostGradeNotify.js — runs after a capstone is graded. Fires:
 *   1. CODING_LEVEL_UP push if the learner's difficulty just bumped.
 *   2. Schedules a CODING_CAPSTONE_AVAILABLE push 7 days out so the
 *      learner knows their next capstone is unlocked.
 *
 * Both notifications go through the unified notificationService which
 * persists an in-app record + best-effort APNs/FCM push.
 *
 * Failure model: caller is the eval worker; this module is wrapped in a
 * try/catch there so a notification glitch never holds back a successful
 * grading. Best-effort.
 */

const CapstoneSession = require('../models/capstoneSession.model');
const DifficultyState = require('../models/difficultyState.model');
const notificationService = require('../../services/notificationService');
const { buildPayload, NOTIFICATION_TYPES } = require('./codingNotifications');
const { Queue } = require('bullmq');
const Redis = require('ioredis');

const FOLLOWUP_QUEUE_NAME = 'capstone-followup';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

let _conn;
let _queue;
function getQueue() {
  if (!_conn) _conn = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  if (!_queue) {
    _queue = new Queue(FOLLOWUP_QUEUE_NAME, {
      connection: _conn,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'fixed', delay: 60_000 },
        removeOnComplete: { count: 200, age: 30 * 24 * 3600 },
        removeOnFail: { count: 200, age: 30 * 24 * 3600 },
      },
    });
  }
  return _queue;
}

/**
 * Called by capstoneEval.worker after a session reaches `graded` status.
 *
 * @param {string} sessionId
 */
async function handleGraded(sessionId) {
  const session = await CapstoneSession.findById(sessionId).lean();
  if (!session || session.status !== 'graded') return;

  await Promise.all([
    maybeFireLevelUp(session),
    scheduleNextCapstoneAvailable(session),
  ]);
}

/**
 * If the user's current difficulty is higher than what it was at the time
 * of this capstone (we infer that by reading the bundle's difficulty
 * vs the current DifficultyState), send the level-up push.
 *
 * The mastery delta + difficulty recalibration happens inside the
 * evaluator pipeline; by the time we get here the DifficultyState already
 * reflects the new level.
 */
async function maybeFireLevelUp(session) {
  const ArtifactBundle = require('../models/artifactBundle.model');
  const bundle = await ArtifactBundle.findById(session.bundle_id).lean();
  if (!bundle) return;

  const ds = await DifficultyState.findOne({
    user_id: session.user_id,
    role_track: bundle.role_track,
  }).lean();
  if (!ds) return;

  const ORDER = ['easy', 'medium', 'hard', 'staff_plus'];
  const previousIdx = ORDER.indexOf(bundle.difficulty);
  const currentIdx = ORDER.indexOf(ds.current_difficulty);
  if (previousIdx === -1 || currentIdx === -1) return;
  if (currentIdx <= previousIdx) return; // no upward bump

  const payload = buildPayload(NOTIFICATION_TYPES.CODING_LEVEL_UP, {
    deepLink: 'scaleup://compass/coding',
    role_track: bundle.role_track,
    from_difficulty: bundle.difficulty,
    to_difficulty: ds.current_difficulty,
    session_id: String(session._id),
  });
  await notificationService.sendToUser(session.user_id, payload);
}

/**
 * Schedule a CODING_CAPSTONE_AVAILABLE push for 7 days from now. The
 * follow-up worker is intentionally simple — it re-checks eligibility
 * at fire time (so a user who turned off coding-objective preferences
 * doesn't get spammed) and only then sends.
 */
async function scheduleNextCapstoneAvailable(session) {
  if (session.is_retry) return; // retries don't reset the 7-day cadence

  const q = getQueue();
  await q.add(
    'send-capstone-available',
    {
      userId: String(session.user_id),
      gradedSessionId: String(session._id),
    },
    {
      delay: SEVEN_DAYS_MS,
      jobId: `capstone-available-${session.user_id}-${Date.now()}`,
    }
  );
}

module.exports = {
  handleGraded,
  FOLLOWUP_QUEUE_NAME,
  _getQueue: getQueue, // exported for the follow-up worker to share state
};
