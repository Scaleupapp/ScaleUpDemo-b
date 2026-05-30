'use strict';

const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');

/**
 * Capstone generation worker — runs the full on-demand generation pipeline
 * (generate → sandbox-validate → cross-model review → activate) off the HTTP
 * path. Each job carries a requestId; the service updates the
 * CapstoneGenerationRequest doc as it progresses so the client can poll.
 *
 * Concurrency 1: generation is LLM- + sandbox-heavy and we don't want a single
 * learner's burst to starve the box. The per-user rate limit on the endpoint
 * (5/hr) keeps the queue depth sane.
 */

const QUEUE_NAME = 'capstone-generation';

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
        attempts: 1, // the service does its own retry/critique loop internally
        removeOnComplete: { count: 200, age: 7 * 24 * 3600 },
        removeOnFail: { count: 200, age: 7 * 24 * 3600 },
      },
    });
  }
  return queue;
}

async function enqueueGeneration(requestId) {
  return getQueue().add(
    'generate',
    { requestId: String(requestId) },
    { jobId: `capstone-gen-${requestId}` }
  );
}

function startCapstoneGenerationWorker() {
  worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const service = require('../services/capstoneGenerationService');
      try {
        await service.runGeneration(job.data.requestId);
      } catch (err) {
        // runGeneration handles its own errors, but belt-and-suspenders: if
        // anything escapes, ensure the request doesn't linger mid-status.
        try {
          const Req = require('../models/capstoneGenerationRequest.model');
          await Req.findByIdAndUpdate(job.data.requestId, {
            $set: { status: 'failed', error: `worker error: ${err.message}` },
          });
        } catch { /* ignore */ }
        throw err;
      }
      return { done: true };
    },
    { connection: getConnection(), concurrency: 1 }
  );
  worker.on('failed', (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[capstone-generation] job failed for request=${job?.data?.requestId}:`, err.message);
  });
  return { worker, queue: getQueue() };
}

module.exports = { enqueueGeneration, startCapstoneGenerationWorker, QUEUE_NAME };
