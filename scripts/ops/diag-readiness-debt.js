#!/usr/bin/env node
/**
 * READ-ONLY (unless --fix-commit-hours) diagnostic for two readiness-debt items:
 *   ITEM 3: objectives with weeklyCommitHours>40 (violates model max:40 → blocks
 *           re-save/analysis). --fix-commit-hours caps them to 40.
 *   ITEM 4: "name-mismatch" cohort — analyzed primary objectives that HAVE
 *           topicMastery data but where NO competency matches it (using the real
 *           matchTopicMastery), so the composite is null. Prints competency names
 *           vs topicMastery topics so we can see whether it's reconcilable.
 *
 * Run:  node scripts/ops/diag-readiness-debt.js [--fix-commit-hours]
 */
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');

const FIX_HOURS = process.argv.includes('--fix-commit-hours');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI not set'); process.exit(1); }
  await mongoose.connect(uri);

  const UserObjective = require('../../src/models/UserObjective');
  const KnowledgeProfile = require('../../src/models/KnowledgeProfile');
  const cms = require('../../src/services/readiness/competencyMasteryService');

  // ── ITEM 3 ───────────────────────────────────────────────────────────────
  const badHours = await UserObjective.find({ weeklyCommitHours: { $gt: 40 } })
    .select('_id userId objectiveType weeklyCommitHours status isPrimary analysis.competencies').lean();
  console.log(`\n===== ITEM 3: weeklyCommitHours>40 (${badHours.length}) =====`);
  for (const o of badHours) {
    const analyzed = (o.analysis?.competencies || []).length;
    console.log(`  obj=${o._id} user=${o.userId} type=${o.objectiveType} hrs=${o.weeklyCommitHours} status=${o.status} primary=${o.isPrimary} analyzed=${analyzed}`);
  }
  if (FIX_HOURS && badHours.length) {
    console.log(`  --fix-commit-hours: capping ${badHours.length} record(s) to 40...`);
    for (const o of badHours) {
      await UserObjective.updateOne({ _id: o._id }, { $set: { weeklyCommitHours: 40 } });
      console.log(`    capped ${o._id} (${o.weeklyCommitHours} -> 40)`);
    }
    console.log('  done. (re-run scripts/migrate/backfillObjectiveAnalysis.js to analyze any now-valid objectives)');
  }

  // ── ITEM 4 ───────────────────────────────────────────────────────────────
  console.log(`\n===== ITEM 4: name-mismatch (analyzed + has data + 0 competency matches) =====`);
  const analyzed = await UserObjective.find({ status: 'active', isPrimary: true, 'analysis.competencies.0': { $exists: true } })
    .select('_id userId objectiveType analysis.competencies').lean();
  let mismatch = 0;
  for (const o of analyzed) {
    const kp = await KnowledgeProfile.findOne({ userId: o.userId }).select('topicMastery').lean();
    const tm = (kp?.topicMastery || []).filter((t) => t && t.topic);
    if (!tm.length) continue; // no-data cohort, not name-mismatch
    const comps = (o.analysis?.competencies || []).map((c) => c.name);
    const matched = comps.filter((name) => cms.matchTopicMastery(name, tm));
    if (matched.length === 0) {
      mismatch++;
      console.log(`\n  user=${o.userId} obj=${o._id} type=${o.objectiveType}`);
      console.log(`    competencies(${comps.length}): ${comps.join(' | ')}`);
      console.log(`    topicMastery(${tm.length}): ${tm.map((t) => `${t.topic}=${t.score}`).join(' | ')}`);
    }
  }
  console.log(`\n  total name-mismatch users: ${mismatch}`);

  await mongoose.disconnect();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
