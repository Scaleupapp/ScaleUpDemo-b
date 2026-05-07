require('dotenv').config();
const mongoose = require('mongoose');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const TopicTaxonomy = require('../../src/models/TopicTaxonomy');
const QuestionBank = require('../../src/models/DiagnosticQuestionBank');

const { seedFromData } = require('./seedTopicTaxonomy');
const { generateAnchorsForTopic } = require('./seedAnchorQuestions');
const { generateBatch, runBatchesInParallel } = require('./seedQuestionBank');
const budget = require('../../src/services/diagnostic/llmCallBudget');

function prompt(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, ans => { rl.close(); res(ans); }));
}

async function runWave2Batch2(opts = {}) {
  const skipPrompts = opts.skipPrompts || process.argv.includes('--yes');

  console.log(`Budget ceiling: ${budget.getLimit()} LLM calls (override via MAX_LLM_CALLS env)`);

  // Step 1: seed state board taxonomy entries
  const boards = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'data', 'wave2-state-boards.json'), 'utf8')
  );
  console.log(`\n=== Step 1: Seed ${boards.length} state board taxonomy entries (MH/TN/KA) ===`);
  if (!skipPrompts && (await prompt('Proceed? (y/N) ')).toLowerCase() !== 'y') return;
  const r1 = await seedFromData(boards);
  console.log(`Upserted ${r1.upserted} taxonomy entries.`);

  // Step 2: anchor questions
  const targetKeys = boards.map(b => b.targetKey);
  const seededTaxonomies = await TopicTaxonomy.find({ targetKey: { $in: targetKeys } }).lean();
  const totalTopicCount = seededTaxonomies.reduce((sum, t) => sum + t.topics.length, 0);

  console.log(`\n=== Step 2: Generate anchors for ${totalTopicCount} topics (LLM, est. $2-5) ===`);
  if (!skipPrompts && (await prompt('Proceed? (y/N) ')).toLowerCase() !== 'y') return;

  let anchorCount = 0;
  let anchorSkipped = 0;
  for (const tax of seededTaxonomies) {
    for (const topic of tax.topics) {
      try {
        const exists = await QuestionBank.exists({
          canonicalCompetency: topic.canonicalName,
          isAnchor: true,
        });
        if (exists) { anchorSkipped++; continue; }
        const anchors = await generateAnchorsForTopic(topic, tax.targetKey);
        await QuestionBank.insertMany(anchors);
        anchorCount += anchors.length;
        process.stdout.write(`\rAnchors generated: ${anchorCount} (skipped: ${anchorSkipped})`);
      } catch (e) {
        console.error(`\nAnchor failure for ${tax.targetKey}::${topic.canonicalName}: ${e.message}`);
      }
    }
  }
  console.log(`\nTotal anchors: ${anchorCount} (skipped existing: ${anchorSkipped})`);

  // Step 3: bulk questions
  const difficulties = ['easy', 'medium', 'hard'];
  const jobs = [];
  let slotsSkipped = 0;
  for (const tax of seededTaxonomies) {
    for (const topic of tax.topics) {
      const anchors = await QuestionBank.find({
        canonicalCompetency: topic.canonicalName,
        isAnchor: true,
      }).lean();
      if (!anchors.length) continue;
      for (const diff of difficulties) {
        const existing = await QuestionBank.countDocuments({
          canonicalCompetency: topic.canonicalName,
          difficulty: diff,
          isAnchor: false,
        });
        if (existing >= 4) { slotsSkipped++; continue; }
        jobs.push(async () => {
          const qs = await generateBatch(topic, tax.targetKey, diff, anchors, 4);
          await QuestionBank.insertMany(qs);
          return qs.length;
        });
      }
    }
  }
  console.log(`\n=== Step 3: Generate bulk questions — ${jobs.length} batches (est. $15-20) ===`);
  console.log(`Skipped slots already at >=4 questions: ${slotsSkipped}`);
  if (!skipPrompts && (await prompt('Proceed? (y/N) ')).toLowerCase() !== 'y') return;

  const results = await runBatchesInParallel(jobs, 6);
  const ok = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;
  const totalQuestions = results
    .filter(r => r.status === 'fulfilled')
    .reduce((sum, r) => sum + r.value, 0);
  console.log(`Done. Batches OK: ${ok}, Failed: ${failed}. Questions generated: ${totalQuestions}`);

  return { taxonomiesUpserted: r1.upserted, anchorsGenerated: anchorCount, questionsGenerated: totalQuestions };
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  try {
    await runWave2Batch2();
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { runWave2Batch2 };
