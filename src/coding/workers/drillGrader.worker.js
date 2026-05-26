const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');

const connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });

const drillGraderQueue = new Queue('coding-drill-grader', { connection });

function startDrillGraderWorker() {
  return new Worker('coding-drill-grader', async (job) => {
    const { drillAttemptId, drill_subtype } = job.data;
    const handler = require(`../services/drillGrader/${drill_subtype}Grader`);
    return handler.grade({ drillAttemptId });
  }, { connection, concurrency: 5 });
}

module.exports = { drillGraderQueue, startDrillGraderWorker };
