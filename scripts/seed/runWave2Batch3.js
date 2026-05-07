require('dotenv').config();
const mongoose = require('mongoose');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const TopicTaxonomy = require('../../src/models/TopicTaxonomy');
const QuestionBank = require('../../src/models/DiagnosticQuestionBank');

const { seedFromData } = require('./seedTopicTaxonomy');
const { seedCompaniesFromData } = require('./seedCompanyProfiles');
const { generateAnchorsForTopic } = require('./seedAnchorQuestions');
const { generateBatch, runBatchesInParallel } = require('./seedQuestionBank');
const budget = require('../../src/services/diagnostic/llmCallBudget');

function prompt(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, ans => { rl.close(); res(ans); }));
}

async function runWave2Batch3(opts = {}) {
  const skipPrompts = opts.skipPrompts || process.argv.includes('--yes');

  console.log(`Budget ceiling: ${budget.getLimit()} LLM calls (override via MAX_LLM_CALLS env)`);

  // Step 1: seed finance exam taxonomies
  const financeExams = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'data', 'wave2-finance-exams.json'), 'utf8')
  );
  console.log(`\n=== Step 1: Seed ${financeExams.length} finance exam taxonomy entries ===`);
  if (!skipPrompts && (await prompt('Proceed? (y/N) ')).toLowerCase() !== 'y') return;
  const r1 = await seedFromData(financeExams);
  console.log(`Upserted ${r1.upserted} taxonomy entries.`);

  // Step 2: seed finance company profiles
  const companies = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'data', 'wave2-companies.json'), 'utf8')
  );
  console.log(`\n=== Step 2: Seed ${companies.length} finance company profiles ===`);
  if (!skipPrompts && (await prompt('Proceed? (y/N) ')).toLowerCase() !== 'y') return;
  const r2 = await seedCompaniesFromData(companies);
  console.log(`Upserted ${r2.upserted} company profiles.`);

  // Step 3: anchor questions for finance exam entries
  const targetKeys = financeExams.map(e => e.targetKey);
  const seededTaxonomies = await TopicTaxonomy.find({ targetKey: { $in: targetKeys } }).lean();
  const totalTopicCount = seededTaxonomies.reduce((sum, t) => sum + t.topics.length, 0);

  console.log(`\n=== Step 3: Generate anchors for ${totalTopicCount} topics (LLM, est. $2-5) ===`);
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

  // Step 4: bulk questions
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
  console.log(`\n=== Step 4: Generate bulk questions — ${jobs.length} batches (est. $20-25) ===`);
  console.log(`Skipped slots already at >=4 questions: ${slotsSkipped}`);
  if (!skipPrompts && (await prompt('Proceed? (y/N) ')).toLowerCase() !== 'y') return;

  const results = await runBatchesInParallel(jobs, 6);
  const ok = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;
  const totalQuestions = results
    .filter(r => r.status === 'fulfilled')
    .reduce((sum, r) => sum + r.value, 0);
  console.log(`Done. Batches OK: ${ok}, Failed: ${failed}. Questions generated: ${totalQuestions}`);

  return {
    taxonomiesUpserted: r1.upserted,
    companiesUpserted: r2.upserted,
    anchorsGenerated: anchorCount,
    questionsGenerated: totalQuestions,
  };
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  try {
    await runWave2Batch3();
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { runWave2Batch3 };
