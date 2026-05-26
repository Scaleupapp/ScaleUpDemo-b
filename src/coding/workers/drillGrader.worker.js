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

function startDrillGraderWorker() {
  return new Worker(
    'coding-drill-grader',
    async (job) => dispatchDrillGrade(job.data),
    { connection, concurrency: 5 }
  );
}

module.exports = { drillGraderQueue, startDrillGraderWorker, dispatchDrillGrade };
