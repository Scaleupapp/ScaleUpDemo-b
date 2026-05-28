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

module.exports = {
  enqueueEvaluation,
  startCapstoneEvalWorker,
  QUEUE_NAME,
};
