require('dotenv').config();
const mongoose = require('mongoose');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const TopicTaxonomy = require('../../src/models/TopicTaxonomy');
const CompanyProfile = require('../../src/models/CompanyProfile');
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

async function main() {
  const skipPrompts = process.argv.includes('--yes');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Budget ceiling: ${budget.getLimit()} LLM calls (override via MAX_LLM_CALLS env)`);

  // Step 1: topics
  const topics = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'wave1-topics.json'), 'utf8'));
  console.log(`\n=== Step 1: Seed ${topics.length} taxonomy entries ===`);
  if (!skipPrompts && (await prompt('Proceed? (y/N) ')).toLowerCase() !== 'y') return;
  const r1 = await seedFromData(topics);
  console.log(`Upserted ${r1.upserted} taxonomy entries.`);

  // Step 2: companies
  const companies = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'wave1-companies.json'), 'utf8'));
  console.log(`\n=== Step 2: Seed ${companies.length} company profiles ===`);
  if (!skipPrompts && (await prompt('Proceed? (y/N) ')).toLowerCase() !== 'y') return;
  const r2 = await seedCompaniesFromData(companies);
  console.log(`Upserted ${r2.upserted} company profiles.`);

  // Step 3: anchors (LLM, ~$5-10)
  const allTopics = await TopicTaxonomy.find({}).lean();
  const totalTopicCount = allTopics.reduce((sum, t) => sum + t.topics.length, 0);
  console.log(`\n=== Step 3: Generate ${totalTopicCount * 2}-${totalTopicCount * 3} anchor questions (LLM, est. $5-10) ===`);
  console.log(`Estimated anchor LLM calls: ${totalTopicCount} (one per topic, cost ~$5-10)`);
  if (!skipPrompts && (await prompt('Proceed? (y/N) ')).toLowerCase() !== 'y') return;
  let anchorCount = 0;
  let anchorSkipped = 0;
  for (const tax of allTopics) {
    for (const topic of tax.topics) {
      try {
        const exists = await QuestionBank.exists({
          canonicalCompetency: topic.canonicalName,
          isAnchor: true,
        });
        if (exists) {
          anchorSkipped++;
          continue;
        }
        const anchors = await generateAnchorsForTopic(topic, tax.targetKey);
        await QuestionBank.insertMany(anchors);
        anchorCount += anchors.length;
        process.stdout.write(`\rAnchors generated: ${anchorCount} (skipped existing: ${anchorSkipped})`);
      } catch (e) {
        console.error(`\nAnchor failure for ${tax.targetKey}::${topic.canonicalName}: ${e.message}`);
      }
    }
  }
  console.log(`\nTotal anchors: ${anchorCount} (skipped existing topics: ${anchorSkipped})`);

  // Step 4: bulk questions (LLM, ~$50)
  console.log(`\n=== Step 4: Generate bulk questions for ~${totalTopicCount * 3} (topic × difficulty) slots (LLM, est. $50) ===`);
  const difficulties = ['easy', 'medium', 'hard'];
  const jobs = [];
  let slotsSkipped = 0;
  for (const tax of allTopics) {
    for (const topic of tax.topics) {
      const anchors = await QuestionBank.find({ canonicalCompetency: topic.canonicalName, isAnchor: true }).lean();
      if (!anchors.length) continue;
      for (const diff of difficulties) {
        const existing = await QuestionBank.countDocuments({
          canonicalCompetency: topic.canonicalName,
          difficulty: diff,
          isAnchor: false,
        });
        if (existing >= 4) {
          slotsSkipped++;
          continue;
        }
        jobs.push(async () => {
          const qs = await generateBatch(topic, tax.targetKey, diff, anchors, 4);
          await QuestionBank.insertMany(qs);
          return qs.length;
        });
      }
    }
  }
  console.log(`Estimated generation calls: ${jobs.length}, validator calls: ${jobs.length * 4}, cost ~$50`);
  console.log(`Skipped slots already at >=4 questions: ${slotsSkipped}`);
  if (!skipPrompts && (await prompt('Proceed? (y/N) ')).toLowerCase() !== 'y') return;
  console.log(`Running ${jobs.length} batches (concurrency=6)...`);
  const results = await runBatchesInParallel(jobs, 6);
  const ok = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;
  const totalQuestions = results
    .filter(r => r.status === 'fulfilled')
    .reduce((sum, r) => sum + r.value, 0);
  console.log(`\nDone. Batches OK: ${ok}, Failed: ${failed}. Total questions: ${totalQuestions}`);

  // Summary
  const taxCount = await TopicTaxonomy.countDocuments();
  const cpCount = await CompanyProfile.countDocuments();
  const qbCount = await QuestionBank.countDocuments();
  const verified = await QuestionBank.countDocuments({ verificationStatus: 'auto_verified' });
  const flagged = await QuestionBank.countDocuments({ verificationStatus: 'flagged_for_review' });
  console.log(`\n=== Wave 1 Summary ===`);
  console.log(`Taxonomies: ${taxCount}`);
  console.log(`Company profiles: ${cpCount}`);
  console.log(`Questions total: ${qbCount}`);
  console.log(`  auto_verified: ${verified}`);
  console.log(`  flagged_for_review: ${flagged}`);

  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
