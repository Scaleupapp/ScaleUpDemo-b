#!/usr/bin/env node

/**
 * Process Seeded Content: Queue all pending content for AI processing
 *
 * Usage: node scripts/processContent.js
 *
 * Finds all Content documents with aiStatus='pending', queues a BullMQ job
 * for each, then starts a worker inline to process them via OpenAI GPT-4o.
 *
 * Requires: MongoDB, Redis (localhost:6379), OPENAI_API_KEY
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');
const Content = require('../src/models/Content');
const processContent = require('../src/workers/contentProcessor');

async function main() {
  // Validate environment
  if (!process.env.MONGODB_URI) {
    console.error('ERROR: MONGODB_URI is not set.');
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error('ERROR: OPENAI_API_KEY is not set.');
    process.exit(1);
  }
  if (!process.env.REDIS_URL) {
    console.error('ERROR: REDIS_URL is not set.');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('  ScaleUp AI Content Processor');
  console.log('='.repeat(60));
  console.log();

  // Connect to MongoDB
  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB.');

  // Connect to Redis
  const connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  console.log('Connected to Redis.');

  // Find all pending content
  const pendingContent = await Content.find({ aiStatus: 'pending' }).select('_id title');
  console.log(`\nFound ${pendingContent.length} content items with aiStatus='pending'.\n`);

  if (pendingContent.length === 0) {
    console.log('Nothing to process. Exiting.');
    await mongoose.disconnect();
    connection.disconnect();
    process.exit(0);
  }

  // Create queue
  const queue = new Queue('contentProcessing', { connection });

  // Queue all jobs
  console.log('Queuing jobs...');
  for (const content of pendingContent) {
    await queue.add('process-content', { contentId: content._id.toString() }, {
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
    });
  }
  console.log(`Queued ${pendingContent.length} jobs.\n`);

  // Track progress
  let completed = 0;
  let failed = 0;
  const total = pendingContent.length;

  // Start worker inline to process the jobs
  console.log('Starting worker... (this will take a while — each video calls OpenAI)\n');

  const worker = new Worker('contentProcessing', async (job) => {
    await processContent(job);
  }, {
    connection,
    concurrency: 2, // process 2 at a time
  });

  worker.on('completed', (job) => {
    completed++;
    console.log(`  [${completed + failed}/${total}] DONE: ${job.data.contentId}`);
  });

  worker.on('failed', (job, err) => {
    failed++;
    console.error(`  [${completed + failed}/${total}] FAIL: ${job.data.contentId} — ${err.message}`);
  });

  // Wait for all jobs to finish
  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (completed + failed >= total) {
        clearInterval(check);
        resolve();
      }
    }, 1000);
  });

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('  PROCESSING COMPLETE');
  console.log('='.repeat(60));
  console.log(`  Total:     ${total}`);
  console.log(`  Completed: ${completed}`);
  console.log(`  Failed:    ${failed}`);
  console.log('='.repeat(60));

  // Cleanup
  await worker.close();
  await queue.close();
  await mongoose.disconnect();
  connection.disconnect();
  console.log('\nDisconnected. Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
