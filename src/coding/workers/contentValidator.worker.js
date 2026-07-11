const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');

const connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });

const contentValidatorQueue = new Queue('coding-content-validator', { connection });

function startContentValidatorWorker() {
  return new Worker('coding-content-validator', async (job) => {
    const validator = require('../services/contentValidator');
    const result = await validator.validate(job.data);
    // Activation gate (Wave 4 block 2): promote a freshly validated DRILL to
    // 'active' via the LLM-judge gate so the scheduled generator actually
    // yields servable bundles. promoteBundle is a no-op for non-drills and for
    // bundles not currently 'validated', so this is safe to call unconditionally.
    if (result && result.ok) {
      try {
        const { promoteBundle } = require('../services/drillPromotion');
        const promotion = await promoteBundle({ bundle_id: job.data.bundle_id });
        return { ...result, promotion };
      } catch (err) {
        console.error('[contentValidator.worker] promotion failed:', err.message);
      }
    }
    return result;
  }, { connection, concurrency: 3 });
}

module.exports = { contentValidatorQueue, startContentValidatorWorker };
