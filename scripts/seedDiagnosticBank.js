#!/usr/bin/env node
/**
 * Seed Script: Pre-populate DiagnosticQuestionBank for common competencies.
 *
 * Usage: node scripts/seedDiagnosticBank.js
 *
 * Strategy: small per-call batches (4 questions each) so every call fits inside
 * the 12s LLM timeout. 16 competencies × 3 difficulties × 2 batches = 96 calls.
 * Processed in parallel groups of 6 to balance OpenAI rate limits and runtime.
 *
 * Idempotent — counts existing bank entries per (competency, difficulty) and
 * only fills what's missing.
 *
 * Run on EC2 after deploying updated diagnosticPoolService.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const diagnosticPoolService = require('../src/services/diagnosticPoolService');
const DiagnosticQuestionBank = require('../src/models/DiagnosticQuestionBank');
const { normalize } = require('../src/services/competencyNormalizer');

const COMPETENCIES = [
  // PM track
  'Product Metrics & Analytics',
  'Feature Prioritization Frameworks',
  'Qualitative User Research',
  'Strategic Roadmap Development',
  'Agile Product Development',
  'Stakeholder Management',
  'Product Vision & Strategy',
  'Go-to-Market Strategy',
  'A/B Testing & Experimentation',
  'User Onboarding Design',
  // Tech / engineering track
  'SQL',
  'System Design',
  'Data Structures',
  'Algorithms',
  'API Design',
  'Distributed Systems',
];

const DIFFICULTIES = ['easy', 'medium', 'hard'];
const QUESTIONS_PER_BATCH = 4;
const BATCHES_PER_DIFFICULTY = 2;     // 4 × 2 = 8 questions per (comp, difficulty)
const TARGET_PER_DIFFICULTY = QUESTIONS_PER_BATCH * BATCHES_PER_DIFFICULTY;
const PARALLEL_BATCH_SIZE = 6;        // how many sub-calls to run in parallel

function buildSubAllocation(comp, difficulty, count) {
  return [{
    name: comp,
    easy:   difficulty === 'easy'   ? count : 0,
    medium: difficulty === 'medium' ? count : 0,
    hard:   difficulty === 'hard'   ? count : 0,
  }];
}

async function processOne({ comp, difficulty, idx }) {
  const t0 = Date.now();
  const allocation = buildSubAllocation(comp, difficulty, QUESTIONS_PER_BATCH);
  try {
    const generated = await diagnosticPoolService._internal.generatePoolFromLLM(
      allocation,
      { objective: comp },
    );
    if (generated.length > 0) {
      await diagnosticPoolService._internal.persistToBank(generated);
    }
    console.log(`  [${idx}] ${comp} / ${difficulty} batch: ${generated.length} questions in ${Date.now() - t0}ms`);
    return generated.length;
  } catch (err) {
    console.error(`  [${idx}] ${comp} / ${difficulty} batch FAILED in ${Date.now() - t0}ms: ${err.message}`);
    return 0;
  }
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('[seedDiagnosticBank] connected');

  // Build the work queue, skipping (comp, difficulty) pairs that are already full.
  const work = [];
  let idx = 0;
  for (const comp of COMPETENCIES) {
    const canonical = normalize(comp);
    for (const difficulty of DIFFICULTIES) {
      const existing = await DiagnosticQuestionBank.countDocuments({
        canonicalCompetency: canonical,
        difficulty,
        status: 'active',
      });
      const missing = Math.max(0, TARGET_PER_DIFFICULTY - existing);
      const batchesNeeded = Math.ceil(missing / QUESTIONS_PER_BATCH);
      if (batchesNeeded === 0) {
        console.log(`[seedDiagnosticBank] ${comp} / ${difficulty}: ${existing} ≥ ${TARGET_PER_DIFFICULTY}, skipping`);
        continue;
      }
      for (let b = 0; b < batchesNeeded; b++) {
        work.push({ comp, difficulty, idx: ++idx });
      }
    }
  }

  console.log(`[seedDiagnosticBank] ${work.length} sub-calls queued, processing ${PARALLEL_BATCH_SIZE} in parallel`);
  const overallStart = Date.now();
  let totalAdded = 0;

  for (let i = 0; i < work.length; i += PARALLEL_BATCH_SIZE) {
    const slice = work.slice(i, i + PARALLEL_BATCH_SIZE);
    console.log(`[seedDiagnosticBank] batch ${Math.floor(i / PARALLEL_BATCH_SIZE) + 1}/${Math.ceil(work.length / PARALLEL_BATCH_SIZE)}…`);
    const results = await Promise.all(slice.map(processOne));
    totalAdded += results.reduce((s, n) => s + n, 0);
  }

  console.log(`[seedDiagnosticBank] done — added ${totalAdded} questions in ${Math.round((Date.now() - overallStart) / 1000)}s`);
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
