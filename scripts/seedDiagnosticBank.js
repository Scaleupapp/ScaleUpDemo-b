#!/usr/bin/env node
/**
 * Seed Script: Pre-populate DiagnosticQuestionBank for common competencies.
 *
 * Usage: node scripts/seedDiagnosticBank.js
 *
 * Generates 8 easy + 8 medium + 8 hard questions per competency (24 per competency,
 * 384 total across 16 competencies) and persists them to the bank so live users
 * hit cache instead of triggering on-demand LLM calls.
 *
 * Skips any competency that already has >= 24 active questions in the bank.
 * Safe to re-run — idempotent per competency.
 *
 * Run this on the EC2 instance after deploying the updated diagnosticPoolService.
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

const QUESTIONS_PER_DIFFICULTY = 8; // 8 easy + 8 medium + 8 hard = 24 per competency = 384 total

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('[seedDiagnosticBank] connected');

  for (const comp of COMPETENCIES) {
    const canonical = normalize(comp);
    const existing = await DiagnosticQuestionBank.countDocuments({ canonicalCompetency: canonical, status: 'active' });
    if (existing >= QUESTIONS_PER_DIFFICULTY * 3) {
      console.log(`[seedDiagnosticBank] ${comp}: ${existing} already, skipping`);
      continue;
    }

    const allocation = [{ name: comp, easy: QUESTIONS_PER_DIFFICULTY, medium: QUESTIONS_PER_DIFFICULTY, hard: QUESTIONS_PER_DIFFICULTY }];
    console.log(`[seedDiagnosticBank] ${comp}: generating ${QUESTIONS_PER_DIFFICULTY * 3} questions...`);
    try {
      const generated = await diagnosticPoolService._internal.generatePoolFromLLM(allocation, { objective: comp });
      console.log(`[seedDiagnosticBank] ${comp}: got ${generated.length} questions`);
      if (generated.length > 0) {
        await diagnosticPoolService._internal.persistToBank(generated);
        console.log(`[seedDiagnosticBank] ${comp}: persisted ${generated.length} questions`);
      }
    } catch (err) {
      console.error(`[seedDiagnosticBank] ${comp}: failed`, err.message);
    }
  }

  await mongoose.disconnect();
  console.log('[seedDiagnosticBank] done');
}

main().catch(err => { console.error(err); process.exit(1); });
