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
      const Req = require('../models/capstoneGenerationRequest.model');
      // Hard ceiling on a single generation. Concurrency is 1, so a job that
      // never settles (e.g. a hung upstream call) would wedge the ENTIRE queue
      // and every learner's generation behind it — which is exactly what
      // happened. Promise.race guarantees the worker always moves on.
      const GEN_TIMEOUT_MS = 9 * 60 * 1000;
      try {
        await Promise.race([
          service.runGeneration(job.data.requestId),
          new Promise((_, reject) => setTimeout(() => reject(new Error('generation exceeded time budget')), GEN_TIMEOUT_MS)),
        ]);
      } catch (err) {
        // runGeneration handles its own errors; this covers a timeout or an
        // escape. Mark the request failed and DO NOT rethrow — we want the
        // worker to free up for the next job, not stall.
        try {
          await Req.findByIdAndUpdate(job.data.requestId, {
            $set: { status: 'failed', error: `generation did not finish in time — please try again (${err.message})` },
          });
        } catch { /* ignore */ }
        return { done: false, error: err.message };
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
