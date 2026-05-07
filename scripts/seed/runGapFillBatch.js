#!/usr/bin/env node
/**
 * runGapFillBatch — targeted gap-fill for coverage holes identified by
 * queryCoverageGaps (Task 5).
 *
 * Usage:
 *   node runGapFillBatch.js --targets "exam_preparation::xat,career_switch::data-analyst::ml-engineer"
 *   node runGapFillBatch.js --targets-file /path/to/targets.txt
 *   node runGapFillBatch.js --dry-run --targets "exam_preparation::xat"
 *
 * Runs idempotently — skips entries that already exist in the taxonomy.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const TopicTaxonomy = require('../../src/models/TopicTaxonomy');
const QuestionBank = require('../../src/models/DiagnosticQuestionBank');

const { generateAnchorsForTopic } = require('./seedAnchorQuestions');
const { generateBatch, runBatchesInParallel } = require('./seedQuestionBank');
const budget = require('../../src/services/diagnostic/llmCallBudget');

/**
 * parseTargetKey — splits a canonicalTarget string into its objectiveType
 * and specifics parts.
 *
 * "exam_preparation::xat"  → { objectiveType: "exam_preparation", specifics: ["xat"] }
 * "career_switch::data-analyst::ml-engineer"
 *   → { objectiveType: "career_switch", specifics: ["data-analyst", "ml-engineer"] }
 */
function parseTargetKey(canonicalTarget) {
  const parts = canonicalTarget.split('::');
  if (parts.length < 2) {
    throw new Error(`Invalid canonicalTarget format: "${canonicalTarget}". Expected "objectiveType::specifics"`);
  }
  const [objectiveType, ...specifics] = parts;
  return { objectiveType, specifics };
}

async function generateTaxonomyForTarget(targetKey, objectiveType) {
  const topicTaxonomyService = require('../../src/services/diagnostic/topicTaxonomyService');
  if (typeof topicTaxonomyService.generateTaxonomyForTargetKey !== 'function') {
    throw new Error(
      'topicTaxonomyService.generateTaxonomyForTargetKey is not implemented. ' +
      'This is a Plan 3a deliverable. Implement it before running gap-fill in production.'
    );
  }
  return topicTaxonomyService.generateTaxonomyForTargetKey(targetKey, objectiveType);
}

async function runGapFillBatch(targets, opts = {}) {
  const dryRun = opts.dryRun || false;

  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('targets must be a non-empty array of canonicalTarget strings');
  }

  console.log(`Budget ceiling: ${budget.getLimit()} LLM calls`);
  console.log(`Processing ${targets.length} gap-fill targets (dryRun=${dryRun})...`);

  const results = {
    skipped: [],
    generated: [],
    failed: [],
  };

  for (const canonicalTarget of targets) {
    let parsed;
    try {
      parsed = parseTargetKey(canonicalTarget);
    } catch (e) {
      console.error(`Invalid target "${canonicalTarget}": ${e.message}`);
      results.failed.push({ targetKey: canonicalTarget, reason: e.message });
      continue;
    }

    const { objectiveType } = parsed;
    const targetKey = canonicalTarget;

    // Idempotency check
    const existing = await TopicTaxonomy.findOne({ targetKey }).lean();
    if (existing) {
      console.log(`[skip] ${targetKey} already exists in taxonomy.`);
      results.skipped.push(targetKey);
      continue;
    }

    console.log(`\n[gap-fill] Generating taxonomy for ${targetKey}...`);
    let taxonomy;
    try {
      taxonomy = await generateTaxonomyForTarget(targetKey, objectiveType);
    } catch (e) {
      console.error(`[gap-fill] Taxonomy generation failed for ${targetKey}: ${e.message}`);
      results.failed.push({ targetKey, reason: e.message });
      continue;
    }

    if (dryRun) {
      console.log(`[dry-run] Would insert taxonomy for ${targetKey} with ${taxonomy.topics.length} topics.`);
      results.generated.push(targetKey);
      continue;
    }

    await TopicTaxonomy.replaceOne(
      { objectiveType: taxonomy.objectiveType, targetKey: taxonomy.targetKey },
      { ...taxonomy, lastRefreshedAt: new Date() },
      { upsert: true }
    );

    // Anchors
    let anchorCount = 0;
    for (const topic of taxonomy.topics) {
      try {
        const anchors = await generateAnchorsForTopic(topic, targetKey);
        await QuestionBank.insertMany(anchors);
        anchorCount += anchors.length;
      } catch (e) {
        console.warn(`[gap-fill] Anchor failure for ${targetKey}::${topic.canonicalName}: ${e.message}`);
      }
    }
    console.log(`[gap-fill] ${targetKey}: inserted taxonomy + ${anchorCount} anchors.`);

    // Bulk questions
    const difficulties = ['easy', 'medium', 'hard'];
    const jobs = [];
    for (const topic of taxonomy.topics) {
      const anchors = await QuestionBank.find({
        canonicalCompetency: topic.canonicalName,
        isAnchor: true,
      }).lean();
      if (!anchors.length) continue;
      for (const diff of difficulties) {
        jobs.push(async () => {
          const qs = await generateBatch(topic, targetKey, diff, anchors, 4);
          await QuestionBank.insertMany(qs);
          return qs.length;
        });
      }
    }
    const batchResults = await runBatchesInParallel(jobs, 4);
    const questionCount = batchResults
      .filter(r => r.status === 'fulfilled')
      .reduce((sum, r) => sum + r.value, 0);
    console.log(`[gap-fill] ${targetKey}: generated ${questionCount} questions.`);
    results.generated.push(targetKey);
  }

  console.log('\n=== Gap-Fill Summary ===');
  console.log(`Skipped (already exist): ${results.skipped.length}`);
  console.log(`Generated: ${results.generated.length}`);
  console.log(`Failed: ${results.failed.length}`);
  if (results.failed.length > 0) {
    for (const f of results.failed) {
      console.log(`  - ${f.targetKey}: ${f.reason}`);
    }
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  let targets = [];
  const targetsIdx = args.indexOf('--targets');
  if (targetsIdx !== -1 && args[targetsIdx + 1]) {
    targets = args[targetsIdx + 1].split(',').map(s => s.trim()).filter(Boolean);
  }

  const targetsFileIdx = args.indexOf('--targets-file');
  if (targetsFileIdx !== -1 && args[targetsFileIdx + 1]) {
    const filePath = args[targetsFileIdx + 1];
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
    targets.push(...lines);
  }

  if (targets.length === 0) {
    console.error('No targets provided. Use --targets "key1,key2" or --targets-file /path/to/list.txt');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  try {
    await runGapFillBatch(targets, { dryRun });
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { runGapFillBatch, parseTargetKey };
