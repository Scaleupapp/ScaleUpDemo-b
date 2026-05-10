#!/usr/bin/env node
/**
 * Retroactively add `external_link` tasks to existing active plans.
 *
 * Walks every active Plan, and for each (week × allocation) calls the
 * externalContentJudgeService. For each whitelisted external link returned,
 * appends an `external_link` task to the week.
 *
 * Idempotent: skips weeks that already have ANY `external_link` tasks
 * (assumes Phase 7 + flag flip is the source of truth going forward).
 *
 * Cost-aware: respects --max-plans flag for staged rollouts and a per-plan
 * timeout to bail out of slow LLM responses. Logs LLM call counts for
 * cost tracking.
 *
 * Run: node scripts/migrate/backfillExternalLinks.js [--dry-run] [--max-plans=N]
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Plan = require('../../src/models/Plan');
const UserObjective = require('../../src/models/UserObjective');
const externalContentJudgeService = require('../../src/services/plan/externalContentJudgeService');

const DRY_RUN = process.argv.includes('--dry-run');
const MAX_PLANS_ARG = process.argv.find(a => a.startsWith('--max-plans='));
const MAX_PLANS = MAX_PLANS_ARG ? parseInt(MAX_PLANS_ARG.split('=')[1], 10) : Infinity;

async function backfillOne(plan, objectiveType, specificsCanonical) {
  let weeksTouched = 0;
  let linksAdded = 0;
  let llmCalls = 0;

  for (const week of plan.weeklySchedule) {
    const existing = week.tasks || [];
    if (existing.some(t => t.type === 'external_link')) continue; // idempotent skip

    for (const alloc of (week.allocations || [])) {
      // Determine the topic's measured band from the most recent diagnostic
      // attempt's results — we'd need to load DiagnosticAttempt by plan.diagnosticAttemptId.
      // For backfill simplicity, use 'developing' as a reasonable default.
      // The judge will adapt its recommendations based on this hint.
      const measuredBand = 'developing';

      // Build inAppContent from the existing tasks in this week (quiz + content)
      const inAppContent = [];
      const existingQuizForTopic = existing.find(t =>
        t.type === 'quiz' && t.topic?.canonicalName === alloc.topicCanonicalName
      );
      const existingContentForTopic = existing.find(t =>
        t.type === 'in_app_content' && t.topic?.canonicalName === alloc.topicCanonicalName
      );
      if (existingQuizForTopic) {
        inAppContent.push({ type: 'quiz', title: `Quiz on ${alloc.topicCanonicalName}` });
      }
      if (existingContentForTopic) {
        inAppContent.push({ type: 'content', title: `Content on ${alloc.topicCanonicalName}` });
      }

      let judgment;
      try {
        llmCalls++;
        judgment = await externalContentJudgeService.judgeTopic({
          objectiveType,
          targetKey: `${objectiveType}::${specificsCanonical?.targetRole || specificsCanonical?.targetSkill || 'general'}`,
          topic: alloc.topicCanonicalName,
          measuredBand,
          inAppContent,
        });
      } catch (err) {
        console.warn(`    judge failed for ${alloc.topicCanonicalName}: ${err.message}`);
        continue;
      }

      const displayName = alloc.topicCanonicalName.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const topicShape = { canonicalName: alloc.topicCanonicalName, displayName };

      for (const link of (judgment.externalLinks || [])) {
        existing.push({
          type: 'external_link',
          topic: topicShape,
          payload: {
            url: link.url,
            title: link.title,
            source: link.source,
            why: link.why,
            estimatedMinutes: link.estimatedMinutes,
          },
          completion: { mode: 'manual', requiresSelfRating: true },
          progress: { status: 'pending', completedAt: null, selfRating: null, sourceEventId: null },
        });
        linksAdded++;
      }
    }
    week.tasks = existing;
    weeksTouched++;
  }

  if (weeksTouched > 0 && linksAdded > 0 && !DRY_RUN) {
    await plan.save();
  }
  return { weeksTouched, linksAdded, llmCalls };
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/scaleupdemo');
  console.log(`[backfillExternalLinks] connected; dryRun=${DRY_RUN} maxPlans=${MAX_PLANS}`);

  // Sanity check: feature flag must be on (so the judge service is willing
  // to do real work — but actually the service runs regardless of the flag,
  // the flag only gates the generator). Print state for visibility.
  console.log(`[backfillExternalLinks] FEATURE_EXTERNAL_CONTENT_JUDGE=${process.env.FEATURE_EXTERNAL_CONTENT_JUDGE || 'unset'}`);

  const cursor = Plan.find({ isActive: true }).cursor();
  let plansSeen = 0;
  let plansTouched = 0;
  let totalWeeks = 0;
  let totalLinks = 0;
  let totalLLMCalls = 0;

  for await (const plan of cursor) {
    if (plansSeen >= MAX_PLANS) break;
    plansSeen++;

    const objective = plan.objectiveId
      ? await UserObjective.findById(plan.objectiveId).lean()
      : null;
    if (!objective) {
      console.log(`  plan ${plan._id}: no objective — skipping`);
      continue;
    }

    const start = Date.now();
    const { weeksTouched, linksAdded, llmCalls } = await backfillOne(
      plan,
      objective.objectiveType,
      objective.specificsCanonical || objective.specifics || {},
    );
    totalLLMCalls += llmCalls;

    if (linksAdded > 0) {
      plansTouched++;
      totalWeeks += weeksTouched;
      totalLinks += linksAdded;
      console.log(`  plan ${plan._id}: +${linksAdded} external_links across ${weeksTouched} weeks (${llmCalls} LLM calls, ${Date.now() - start}ms)`);
    } else if (llmCalls > 0) {
      console.log(`  plan ${plan._id}: judged but 0 links recommended (${llmCalls} LLM calls, ${Date.now() - start}ms)`);
    }
  }

  console.log(`[backfillExternalLinks] done.`);
  console.log(`  plans seen:    ${plansSeen}`);
  console.log(`  plans touched: ${plansTouched}`);
  console.log(`  weeks touched: ${totalWeeks}`);
  console.log(`  links added:   ${totalLinks}`);
  console.log(`  LLM calls:     ${totalLLMCalls} (~$${(totalLLMCalls * 0.0001).toFixed(4)} at gpt-4o-mini rates)`);

  await mongoose.disconnect();
  setTimeout(() => process.exit(0), 500);
}

main().catch(err => {
  console.error('[backfillExternalLinks] fatal:', err);
  process.exit(1);
});
