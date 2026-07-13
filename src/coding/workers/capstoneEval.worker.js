'use strict';

const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');
const evaluator = require('../services/capstoneEvaluator');
const alerts = require('../services/alerts');

/**
 * Capstone Evaluator worker.
 *
 * Enqueued from capstones.controller.applyControl when a session transitions
 * to `submitted`. The worker calls evaluator.evaluate(sessionId) which runs
 * the full pipeline (harness + diff + scorer + anchor-drift).
 *
 * Retry policy:
 *   - 3 attempts with exponential backoff (5s, 20s, 80s)
 *   - On final failure the session is left in `submitted`; the recording
 *     is preserved; an alert is logged. A separate ops dashboard surfaces
 *     stuck sessions for manual re-trigger (spec §12.3).
 *
 * Concurrency: 4. Each pipeline run takes 3–10 min wall-clock (sandbox
 * provision + tests + Sonnet call), so 4 workers caps us at ~24 / hour
 * which matches the spec's target launch volume of 1 capstone / learner /
 * week.
 */

const QUEUE_NAME = 'capstone-eval';

let connection;
let queue;
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
        // Job records retained for ops dashboards
        removeOnComplete: { count: 500, age: 7 * 24 * 3600 },
        removeOnFail: { count: 500, age: 30 * 24 * 3600 },
      },
    });
  }
  return queue;
}

/**
 * Enqueue an evaluation job for a session. Idempotent on jobId so duplicate
 * submit-events don't double-grade.
 *
 * @param {string} sessionId
 */
async function enqueueEvaluation(sessionId) {
  const q = getQueue();
  // If a previous run EXHAUSTED its retries, the failed job still occupies the
  // idempotent jobId and q.add() would silently no-op — the session could then
  // never be re-graded (Wave 2 block 6). Clear a failed/completed job first;
  // active/waiting jobs are left alone so in-flight grading is never disturbed.
  try {
    const existing = await q.getJob(`capstone-eval-${sessionId}`);
    if (existing) {
      const state = await existing.getState();
      if (state === 'failed' || state === 'completed') await existing.remove();
    }
  } catch (_) { /* best-effort — fall through to add */ }
  return q.add(
    'evaluate',
    { sessionId: String(sessionId) },
    { jobId: `capstone-eval-${sessionId}` }
  );
}

function startCapstoneEvalWorker() {
  worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { sessionId } = job.data;
      const result = await evaluator.evaluate({ sessionId });

      // Proof-journey correlation hook (agentic layer, Plan 5 Task 4
      // EXPANDED) — advances any proof journey correlated to this capstone
      // session now that it's graded (evaluator.evaluate only resolves once
      // the grade has persisted and the session has transitioned to
      // 'graded'). This job's data only carries sessionId, so we look up
      // user_id off the just-graded session. Deliberately NOT awaited —
      // fire-and-forget, never in the worker's critical path — and the
      // require() calls are wrapped in try/catch so a require-time failure
      // can't throw synchronously into the job handler either.
      try {
        const CapstoneSession = require('../models/capstoneSession.model');
        const proofJourneyService = require('../../services/proofJourneyService');
        CapstoneSession.findById(sessionId)
          .select('user_id')
          .lean()
          .then((sess) => (sess ? proofJourneyService.advanceOnCapstoneGraded({ userId: sess.user_id, sessionId }) : null))
          .catch((e) => console.warn('[proofJourneyHook]', e.message));
      } catch (e) {
        console.warn('[proofJourneyHook] hook setup failed:', e.message);
      }

      // Post-grade recalibration — feeds capstone dimension scores into the
      // same MetaSkillMastery + DifficultyState loop the drills already use.
      // Must run BEFORE notifications so the level-up push reflects the
      // freshly-bumped difficulty.
      try {
        const recalibrate = require('../services/capstonePostGradeRecalibrate');
        await recalibrate.applyPostGradeRecalibrationForCapstone(sessionId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[capstone-eval] post-grade recalibration failed for ${sessionId}: ${err.message}`);
      }
      // Post-grade notifications — non-fatal; never block the worker chain.
      try {
        const postGrade = require('../services/capstonePostGradeNotify');
        await postGrade.handleGraded(sessionId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[capstone-eval] post-grade notify failed for ${sessionId}: ${err.message}`);
      }
      return result;
    },
    {
      connection: getConnection(),
      concurrency: 4,
    }
  );

  worker.on('failed', (job, err) => {
    if (job.attemptsMade >= (job.opts.attempts || 3)) {
      // eslint-disable-next-line no-console
      console.error(
        `[capstone-eval] EXHAUSTED for session=${job.data.sessionId} after ${job.attemptsMade} attempts:`,
        err.message
      );
      // Stranding fix (Wave 2 block 6): a session left in 'evaluating' after
      // the final retry would show "grading…" forever. Revert to 'submitted'
      // (direct conditional update — the state machine has no evaluating→
      // submitted edge by design) so the ops path (sandbox-gc re-enqueue /
      // admin regrade) can pick it up from a known state.
      void revertEvaluatingToSubmitted(job.data.sessionId).catch((e) => {
        // eslint-disable-next-line no-console
        console.error(`[capstone-eval] could not revert session ${job.data.sessionId}: ${e.message}`);
      });
      void alerts.fire({
        category: 'worker.job-exhausted',
        severity: 'error',
        title: `capstone-eval exhausted for session ${job.data.sessionId}`,
        detail: '```\n' + (err.stack || err.message) + '\n```',
        dedupKey: `eval:${job.data.sessionId}`,
        fields: { session_id: String(job.data.sessionId), attempts: String(job.attemptsMade) },
      });
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `[capstone-eval] attempt ${job.attemptsMade} failed for session=${job.data.sessionId}: ${err.message}`
      );
    }
  });

  return { worker, queue: getQueue() };
}

/**
 * Revert a stuck 'evaluating' session to 'submitted' (recovery path only).
 * Conditional on current status so a concurrent successful grade wins.
 */
async function revertEvaluatingToSubmitted(sessionId) {
  const CapstoneSession = require('../models/capstoneSession.model');
  return CapstoneSession.findOneAndUpdate(
    { _id: sessionId, status: 'evaluating' },
    { $set: { status: 'submitted' } },
    { new: true }
  );
}

/**
 * Remove a (completed/failed) evaluation job so the idempotent jobId can be
 * re-enqueued — used by the admin regrade endpoint. Best-effort.
 */
async function removeEvaluationJob(sessionId) {
  const q = getQueue();
  const job = await q.getJob(`capstone-eval-${sessionId}`);
  if (job) await job.remove();
  return !!job;
}

module.exports = {
  enqueueEvaluation,
  startCapstoneEvalWorker,
  revertEvaluatingToSubmitted,
  removeEvaluationJob,
  QUEUE_NAME,
};
