'use strict';

const { Queue, Worker, QueueScheduler } = require('bullmq');
const Redis = require('ioredis');
const CapstoneSession = require('../models/capstoneSession.model');
const sandboxOrchestrator = require('../services/sandboxOrchestrator');
const stateMachine = require('../services/sessionStateMachine');
const capstoneEvalWorker = require('./capstoneEval.worker');
const snapshotService = require('../services/snapshotService');

/**
 * Sandbox GC worker — belt-and-suspenders on top of e2b's own wall-clock
 * limits. Runs every 5 min:
 *
 *   1. Kill sandboxes for sessions that have been submitted/graded/aborted
 *      for > 5 min (e2b also reaps but we don't want to wait for that).
 *   2. Auto-expire `ready` and `in_progress` sessions past their wall-clock
 *      budget (spec §12.2 "Timer ends mid-thought → 60s grace + 30s hard
 *      buffer; auto-submit captures state").
 *   3. Top up the warm pool toward target sizes (sandboxOrchestrator does
 *      the work; this worker just calls the function on a schedule).
 *
 * The expiry path transitions: in_progress → expired → submitted, which
 * triggers the same submit-side effects (recording finalize + teardown +
 * eval enqueue, the latter lands in WS4).
 */

const QUEUE_NAME = 'capstone-sandbox-gc';
const TICK_INTERVAL_MS = 5 * 60 * 1000;
const GRACE_MS_AFTER_SUBMIT = 5 * 60 * 1000;
const HARD_BUFFER_SECONDS = 30; // matches spec §12.2 (the +30s after the 60s grace warning)
// A session created from the mobile "Start" tap sits at scheduled → provisioning
// → ready until the learner pairs and begins on their laptop. If they never do
// (closed the app, provisioning hung, sandbox died), it has no started_at and no
// expires_at, so the over-budget sweep below never touches it — it would block
// the learner's next capstone forever. Reap anything stuck unstarted past this.
const STALE_UNSTARTED_MS = 30 * 60 * 1000;

let connection;
let queue;
let scheduler;
let worker;

function getConnection() {
  if (!connection) {
    connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  }
  return connection;
}

function getQueue() {
  if (!queue) {
    queue = new Queue(QUEUE_NAME, {
      connection: getConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 50 },
      },
    });
  }
  return queue;
}

/**
 * One GC tick. Exported so tests can call it without spinning a worker.
 *
 * @returns {Promise<{ teardowns: number, expired: number, poolTopUp: object }>}
 */
async function tick() {
  const summary = { teardowns: 0, expired: 0, poolTopUp: null };

  // 1. Tear down sandboxes for terminal-state sessions older than 5 min.
  const teardownCutoff = new Date(Date.now() - GRACE_MS_AFTER_SUBMIT);
  const teardownCandidates = await CapstoneSession.find({
    status: { $in: ['submitted', 'evaluating', 'graded', 'aborted'] },
    sandbox_id: { $ne: null },
    updatedAt: { $lt: teardownCutoff },
  })
    .select('_id sandbox_id')
    .lean();

  for (const s of teardownCandidates) {
    try {
      await sandboxOrchestrator.teardownForSession(s._id);
      await CapstoneSession.findByIdAndUpdate(s._id, {
        $unset: { sandbox_id: '', sandbox_host_url: '' },
      });
      summary.teardowns += 1;
    } catch (err) {
      // Log + continue; one stuck sandbox shouldn't stop the others.
      // eslint-disable-next-line no-console
      console.warn('[sandbox-gc] teardown failed:', s._id, err.message);
    }
  }

  // 2. Auto-expire over-budget sessions. We use the session's
  //    started_at + time_budget_seconds + HARD_BUFFER to decide.
  const inFlight = await CapstoneSession.find({
    status: { $in: ['in_progress', 'paused'] },
    started_at: { $ne: null },
  })
    .select('_id status started_at paused_total_seconds time_budget_seconds')
    .lean();

  const now = Date.now();
  for (const s of inFlight) {
    const elapsedSec = Math.floor(
      (now - s.started_at.getTime()) / 1000 - (s.paused_total_seconds || 0)
    );
    if (elapsedSec > s.time_budget_seconds + HARD_BUFFER_SECONDS) {
      try {
        await stateMachine.transition(s._id, 'expired');
        await stateMachine.transition(s._id, 'submitted');
        summary.expired += 1;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[sandbox-gc] expire failed:', s._id, err.message);
      }
    }
  }

  // 2b. Reap stale NEVER-STARTED sessions (scheduled/provisioning/ready with no
  //     started_at, untouched for > STALE_UNSTARTED_MS). These have no expiry to
  //     time out against, so step 2 ignores them; left alone they (a) block the
  //     learner's "Start a capstone" CTA indefinitely and (b) surfaced on the
  //     summary as an in_progress with no expires_at. Abort them; step 1 reaps
  //     any sandbox they hold on a later tick.
  const unstartedCutoff = new Date(Date.now() - STALE_UNSTARTED_MS);
  const unstarted = await CapstoneSession.find({
    status: { $in: ['scheduled', 'provisioning', 'ready'] },
    started_at: null,
    updatedAt: { $lt: unstartedCutoff },
  })
    .select('_id status')
    .lean();
  summary.reapedUnstarted = 0;
  for (const s of unstarted) {
    try {
      await stateMachine.transition(s._id, 'aborted');
      summary.reapedUnstarted += 1;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[sandbox-gc] reap unstarted failed:', s._id, err.message);
    }
  }

  // 2c. Fail stuck capstone-GENERATION requests. A request left in a
  //     non-terminal status too long (worker wedged on a hung upstream call, or
  //     the process restarted mid-job) would otherwise show "Building…" forever
  //     on the client. The generation worker now has its own 9-min ceiling; this
  //     is the backstop and cleans up any that predate it.
  try {
    const CapstoneGenerationRequest = require('../models/capstoneGenerationRequest.model');
    const genCutoff = new Date(Date.now() - 12 * 60 * 1000);
    const res = await CapstoneGenerationRequest.updateMany(
      { status: { $in: ['queued', 'generating', 'validating', 'cross_checking'] }, updatedAt: { $lt: genCutoff } },
      { $set: { status: 'failed', error: 'Generation timed out — please try again.' } }
    );
    summary.failedStuckGenerations = res.modifiedCount || 0;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[sandbox-gc] stuck-generation cleanup failed:', err.message);
  }

  // 3. Recover stuck submits — sessions that have been `submitted` for
  //    > 2 min without a worker picking up the eval job (Redis blip during
  //    submit). Idempotent enqueue on sessionId so safe to repeat.
  const stuckCutoff = new Date(Date.now() - 2 * 60 * 1000);
  const stuck = await CapstoneSession.find({
    status: 'submitted',
    submitted_at: { $lt: stuckCutoff },
  })
    .select('_id')
    .lean();
  summary.recoveredSubmits = 0;
  for (const s of stuck) {
    try {
      await capstoneEvalWorker.enqueueEvaluation(s._id);
      summary.recoveredSubmits += 1;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[sandbox-gc] re-enqueue eval failed:', s._id, err.message);
    }
  }

  // 3a. Snapshot capture — for every active session, ask the snapshot
  //     service to capture (no-ops if SNAPSHOT_INTERVAL_SEC hasn't
  //     elapsed since the last one). Cheap; bounded by number of active
  //     sessions × ~MAX_FILES_PER_SNAPSHOT.
  const active = await CapstoneSession.find({
    status: { $in: ['in_progress', 'paused'] },
    sandbox_id: { $ne: null },
  })
    .select('_id')
    .lean();
  summary.snapshotsCaptured = 0;
  for (const s of active) {
    try {
      const r = await snapshotService.captureForSession(s._id);
      if (r.captured) summary.snapshotsCaptured += 1;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[sandbox-gc] snapshot capture failed:', s._id, err.message);
    }
  }

  // 4. Warm pool top-up.
  try {
    summary.poolTopUp = await sandboxOrchestrator.topUpPool();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[sandbox-gc] pool top-up failed:', err.message);
  }

  return summary;
}

function startSandboxGcWorker() {
  // QueueScheduler is what schedules repeatable jobs in BullMQ < v5; for
  // v5+ it's bundled with Queue. Guard the import in case both versions
  // are present in the resolver.
  try {
    scheduler = new QueueScheduler(QUEUE_NAME, { connection: getConnection() });
  } catch {
    scheduler = null;
  }

  worker = new Worker(QUEUE_NAME, async () => tick(), {
    connection: getConnection(),
    concurrency: 1,
  });

  // Kick off the recurring tick — bull v4 vs v5 differ, this works on both.
  getQueue().add(
    'tick',
    {},
    {
      repeat: { every: TICK_INTERVAL_MS },
      jobId: 'capstone-sandbox-gc-recurring',
    }
  );

  return { worker, scheduler, queue: getQueue() };
}

module.exports = {
  tick,
  startSandboxGcWorker,
  TICK_INTERVAL_MS,
  HARD_BUFFER_SECONDS,
};
