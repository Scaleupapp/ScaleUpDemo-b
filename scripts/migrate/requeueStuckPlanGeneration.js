#!/usr/bin/env node
/**
 * Re-enqueue stuck plan generation for users who completed a diagnostic but
 * have no active Plan.
 *
 * State C users: latest DiagnosticAttempt.status === 'completed' AND
 *   planGenerationStatus IN ['pending', 'failed', null]
 *   AND no Plan exists with userId + isActive: true.
 *
 * For each match, enqueue planGenerationQueue.add('generate', {attemptId})
 * — same job the diagnostic finishAttempt path enqueues.
 *
 * Idempotent: only operates on users who currently have NO active plan, so
 * re-running after the worker has produced plans is a no-op.
 *
 * Run: node scripts/migrate/requeueStuckPlanGeneration.js [--dry-run]
 */
require('dotenv').config();
const mongoose = require('mongoose');
const DiagnosticAttempt = require('../../src/models/DiagnosticAttempt');
const Plan = require('../../src/models/Plan');
const { planGenerationQueue } = require('../../src/config/queue');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/scaleupdemo');
  console.log(`[requeueStuckPlanGen] connected; dryRun=${DRY_RUN}`);

  // Walk completed attempts, newest first per user. We use aggregation to get
  // the latest completed attempt per user, then filter to those with no active plan.
  const stuck = await DiagnosticAttempt.aggregate([
    { $match: { status: 'completed' } },
    { $sort: { completedAt: -1 } },
    { $group: {
        _id: '$userId',
        attemptId: { $first: '$_id' },
        completedAt: { $first: '$completedAt' },
        planGenerationStatus: { $first: '$planGenerationStatus' },
        planId: { $first: '$planId' },
    }},
  ]);

  let seen = 0;
  let enqueued = 0;
  let skipped = 0;

  for (const row of stuck) {
    seen++;
    // If this user already has an active plan, skip.
    const activePlan = await Plan.findOne({ userId: row._id, isActive: true })
      .select('_id').lean();
    if (activePlan) { skipped++; continue; }

    // No active plan — enqueue
    console.log(`  user ${row._id} attempt ${row.attemptId} (status=${row.planGenerationStatus || 'null'}, completedAt=${row.completedAt.toISOString()})`);
    if (!DRY_RUN) {
      try {
        await planGenerationQueue.add('generate', { attemptId: String(row.attemptId) });
        // Reset planGenerationStatus so the worker can update it on completion.
        await DiagnosticAttempt.updateOne(
          { _id: row.attemptId },
          { $set: { planGenerationStatus: 'pending' } }
        );
        enqueued++;
      } catch (err) {
        console.warn(`    enqueue failed: ${err.message}`);
      }
    } else {
      enqueued++; // count in dry-run
    }
  }

  console.log(`[requeueStuckPlanGen] done. seen=${seen} enqueued=${enqueued} skipped=${skipped}`);
  await mongoose.disconnect();
  // Give BullMQ a moment to flush, then exit
  setTimeout(() => process.exit(0), 1000);
}

main().catch(err => {
  console.error('[requeueStuckPlanGen] fatal:', err);
  process.exit(1);
});
