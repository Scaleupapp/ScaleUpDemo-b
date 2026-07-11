const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');

const connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });

const drillGraderQueue = new Queue('coding-drill-grader', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  },
});

async function dispatchDrillGrade(jobData) {
  const { drillAttemptId, drill_subtype } = jobData;
  const validSubtypes = ['prompt', 'verify', 'decompose', 'refactor'];
  if (!validSubtypes.includes(drill_subtype)) {
    throw new Error(`Unknown drill_subtype: ${drill_subtype}`);
  }
  const handler = require(`../services/drillGrader/${drill_subtype}Grader`);
  return handler.grade({ drillAttemptId });
}

/**
 * Final-retry stranding fix (Wave 2 block 6): when a grade job exhausts its
 * retries the attempt used to stay 'submitted' forever — the student's result
 * poll returned 202 eternally. Mark it 'failed' so the controller can surface
 * a terminal state; admin regrade can requeue it.
 *
 * Exported for direct unit testing.
 */
async function markDrillAttemptFailed(drillAttemptId, reason) {
  const { DrillAttempt } = require('../models');
  return DrillAttempt.findOneAndUpdate(
    { _id: drillAttemptId, status: 'submitted' },
    { $set: { status: 'failed', failure_reason: String(reason || 'grading failed').slice(0, 500) } },
    { new: true }
  );
}

function startDrillGraderWorker() {
  const worker = new Worker(
    'coding-drill-grader',
    async (job) => dispatchDrillGrade(job.data),
    { connection, concurrency: 5 }
  );

  worker.on('failed', (job, err) => {
    const attemptId = job && job.data && job.data.drillAttemptId;
    const maxAttempts = (job && job.opts && job.opts.attempts) || 3;
    if (job && job.attemptsMade >= maxAttempts) {
      // eslint-disable-next-line no-console
      console.error(
        `[drill-grader] EXHAUSTED for attempt=${attemptId} subtype=${job.data && job.data.drill_subtype} after ${job.attemptsMade} attempts: ${err.message}`
      );
      void markDrillAttemptFailed(attemptId, err.message).catch((e) => {
        // eslint-disable-next-line no-console
        console.error(`[drill-grader] could not mark attempt ${attemptId} failed: ${e.message}`);
      });
      void require('../services/alerts')
        .fire({
          category: 'worker.job-exhausted',
          severity: 'error',
          title: `drill-grader exhausted for attempt ${attemptId}`,
          detail: '```\n' + (err.stack || err.message) + '\n```',
          dedupKey: `drill:${attemptId}`,
          fields: { attempt_id: String(attemptId), attempts: String(job.attemptsMade) },
        })
        .catch(() => {});
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `[drill-grader] attempt ${job && job.attemptsMade} failed for attempt=${attemptId}: ${err.message}`
      );
    }
  });

  return worker;
}

module.exports = { drillGraderQueue, startDrillGraderWorker, dispatchDrillGrade, markDrillAttemptFailed };
