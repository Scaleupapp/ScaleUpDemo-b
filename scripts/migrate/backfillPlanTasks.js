#!/usr/bin/env node
/**
 * Backfill tasks[] on existing active plans.
 *
 * Phase 2 introduces tasks[] to the Plan model. Plans created before this
 * migration have weeklySchedule[i].tasks empty. This script walks each
 * active plan, calls taskCatalogService.resolveTopic for every allocation,
 * and writes the resulting tasks[].
 *
 * Idempotent: skips weeks that already have a non-empty tasks array.
 *
 * Run: node scripts/migrate/backfillPlanTasks.js [--dry-run]
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Plan = require('../../src/models/Plan');
const UserObjective = require('../../src/models/UserObjective');
const taskCatalogService = require('../../src/services/plan/taskCatalogService');

const DRY_RUN = process.argv.includes('--dry-run');

async function backfillOne(plan) {
  let touched = 0;
  let tasksAdded = 0;
  const objective = plan.objectiveId
    ? await UserObjective.findById(plan.objectiveId).lean()
    : null;
  const objectiveType = objective?.objectiveType || null;

  for (const week of plan.weeklySchedule) {
    if ((week.tasks || []).length > 0) continue; // idempotent skip
    const tasks = [];
    for (const alloc of (week.allocations || [])) {
      const resolved = await taskCatalogService.resolveTopic({
        topicCanonicalName: alloc.topicCanonicalName,
        objectiveType,
        objectiveId: plan.objectiveId,
      });
      const displayName = alloc.topicCanonicalName
        .replace(/-/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
      const topicShape = { canonicalName: alloc.topicCanonicalName, displayName };
      if (resolved.quizId) {
        tasks.push({
          type: 'quiz', topic: topicShape,
          payload: { quizId: resolved.quizId, estimatedMinutes: resolved.quizMinutes },
          completion: { mode: 'auto', requiresSelfRating: false },
          progress: { status: 'pending' },
        });
        tasksAdded++;
      }
      if (resolved.contentId) {
        tasks.push({
          type: 'in_app_content', topic: topicShape,
          payload: {
            contentId: resolved.contentId,
            contentType: resolved.contentType,
            estimatedMinutes: resolved.contentMinutes,
          },
          completion: { mode: 'auto', requiresSelfRating: false },
          progress: { status: 'pending' },
        });
        tasksAdded++;
      }
    }
    week.tasks = tasks;
    touched++;
  }
  if (touched > 0 && !DRY_RUN) {
    await plan.save();
  }
  return { weeksTouched: touched, tasksAdded };
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/scaleupdemo');
  console.log(`[backfillPlanTasks] connected; dryRun=${DRY_RUN}`);

  const cursor = Plan.find({ isActive: true }).cursor();
  let plansSeen = 0, plansTouched = 0, totalWeeks = 0, totalTasks = 0;

  for await (const plan of cursor) {
    plansSeen++;
    const { weeksTouched, tasksAdded } = await backfillOne(plan);
    if (weeksTouched > 0) {
      plansTouched++;
      totalWeeks += weeksTouched;
      totalTasks += tasksAdded;
      console.log(`  plan ${plan._id}: +${tasksAdded} tasks across ${weeksTouched} weeks`);
    }
  }

  console.log(`[backfillPlanTasks] done. seen=${plansSeen} touched=${plansTouched} weeks=${totalWeeks} tasks=${totalTasks}`);
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('[backfillPlanTasks] fatal:', err);
  process.exit(1);
});
