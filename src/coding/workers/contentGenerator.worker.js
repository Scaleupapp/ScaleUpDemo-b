const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');

const connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });

const contentGeneratorQueue = new Queue('coding-content-generator', { connection });

function startContentGeneratorWorker() {
  return new Worker('coding-content-generator', async (job) => {
    const generator = require('../services/contentGenerator');
    return generator.generate(job.data);
  }, { connection, concurrency: 2 });
}

module.exports = { contentGeneratorQueue, startContentGeneratorWorker };
