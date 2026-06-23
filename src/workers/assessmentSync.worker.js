'use strict';
/**
 * Assessment Sync Worker
 *
 * Periodically polls in_progress AssessmentSessions, calls syncSession for each
 * (idempotent — no-op once graded), and marks expired sessions that have passed
 * their Assessment.closesAt deadline without ever being graded.
 *
 * BullMQ wiring: a single repeatable job fires every 60 s. The core loop is
 * extracted into `runSyncTick(deps)` so unit tests can drive it with injected
 * fakes and no Redis/Mongo required.
 */

const QUEUE_NAME = 'assessment-sync';
const REPEAT_EVERY_MS = 60_000; // 60 seconds

// ─── Testable core loop ──────────────────────────────────────────────────────

/**
 * runSyncTick — the core work unit. Injected-deps friendly for unit tests.
 *
 * @param {object} deps
 * @param {object} deps.AssessmentSession  - mongoose model (or stub)
 * @param {object} deps.Assessment         - mongoose model (or stub)
 * @param {Function} deps.syncSession      - assessmentSessionService.syncSession (or stub)
 * @param {Function} [deps.now]            - () => Date, defaults to () => new Date()
 */
async function runSyncTick(deps = {}) {
  const AssessmentSession = deps.AssessmentSession || require('../models/AssessmentSession');
  const Assessment = deps.Assessment || require('../models/Assessment');
  const syncSession = deps.syncSession || require('../services/institution/assessment/assessmentSessionService').syncSession;
  const now = (deps.now && deps.now()) || new Date();

  // Load all in_progress sessions (optionally could add a small age filter,
  // e.g. startedAt < now - 5s, but correctness is more important than precision).
  const sessions = await AssessmentSession.find({ status: 'in_progress' });

  for (const session of sessions) {
    try {
      // Check for expiry first: if the assessment window has closed AND the
      // session is still in_progress (engine never graded it), mark it expired
      // so it stops polluting the batch forever.
      let assessment;
      try {
        assessment = await Assessment.findById(session.assessmentId);
      } catch (_) {
        assessment = null;
      }

      if (assessment && assessment.closesAt && now > assessment.closesAt) {
        // Window closed — do ONE final sync first so that a session the engine
        // graded right as the window closed gets finalized (graded+active) instead
        // of being lost to 'expired'. Only expire if still not graded after the sync.
        await syncSession(session._id);
        // Re-read the (possibly-updated) session after the sync.
        const refreshed = AssessmentSession.findById
          ? await AssessmentSession.findById(session._id)
          : null;
        const statusAfterSync = (refreshed && refreshed.status) || session.status;
        if (statusAfterSync !== 'graded') {
          session.status = 'expired';
          await session.save();
          console.log(`[assessmentSync] expired session ${session._id} (closesAt passed, still ungraded after final sync)`);
        } else {
          console.log(`[assessmentSync] session ${session._id} graded on final-sync (closesAt passed); not expired`);
        }
        continue;
      }

      // Not expired — poll the engine.
      await syncSession(session._id);
    } catch (err) {
      // One failure must not abort the batch.
      console.warn(`[assessmentSync] syncSession failed for ${session._id}: ${err.message}`);
    }
  }
}

// ─── BullMQ wiring ──────────────────────────────────────────────────────────

let connection;
let queue;
let worker;

function getConnection() {
  if (!connection) {
    const Redis = require('ioredis');
    connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  }
  return connection;
}

function getQueue() {
  if (!queue) {
    const { Queue } = require('bullmq');
    queue = new Queue(QUEUE_NAME, {
      connection: getConnection(),
      defaultJobOptions: {
        removeOnComplete: { count: 100, age: 24 * 3600 },
        removeOnFail: { count: 200, age: 7 * 24 * 3600 },
      },
    });
  }
  return queue;
}

/**
 * Register the repeatable job and start the worker.
 * Called from src/workers/index.js startWorkers().
 */
function startAssessmentSyncWorker() {
  const { Worker } = require('bullmq');

  const q = getQueue();

  // Register a repeatable job — BullMQ is idempotent on the same jobId+pattern.
  q.add('sync', {}, {
    repeat: { every: REPEAT_EVERY_MS },
    jobId: 'assessment-sync-repeatable',
  });

  worker = new Worker(
    QUEUE_NAME,
    async (_job) => {
      await runSyncTick();
    },
    {
      connection: getConnection(),
      concurrency: 1, // Serialised — no overlapping ticks needed.
    }
  );

  worker.on('failed', (_job, err) => {
    console.error(`[assessment-sync] worker failed: ${err.message}`);
  });

  return { worker, queue: getQueue() };
}

module.exports = {
  runSyncTick,           // exported for unit tests
  startAssessmentSyncWorker,
  QUEUE_NAME,
};
