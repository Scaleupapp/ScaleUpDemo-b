const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');

const connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });

const contentValidatorQueue = new Queue('coding-content-validator', { connection });

function startContentValidatorWorker() {
  return new Worker('coding-content-validator', async (job) => {
    const validator = require('../services/contentValidator');
    return validator.validate(job.data);
  }, { connection, concurrency: 3 });
}

module.exports = { contentValidatorQueue, startContentValidatorWorker };
