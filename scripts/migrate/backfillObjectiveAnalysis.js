#!/usr/bin/env node
/**
 * Backfill the Objective Intelligence competency framework for active objectives
 * that were never analyzed. Without `analysis.competencies` an objective can't
 * produce a composite readiness or a computed target — the audit found ~94% of
 * active objectives in this state, so the redesign is inert for them.
 *
 * Runs analyzeObjective with { triggerAssessments: false } — we want the framework
 * (to weight EXISTING signal: diagnostic + quizzes + coding + interviews), NOT to
 * fire ~12 quiz-gen jobs per objective across the whole fleet.
 *
 * IDEMPOTENT: only objectives missing analysis are touched; re-runs skip the rest.
 * COST: one Claude Sonnet 4 call per objective (no assessment jobs).
 *
 * Run:  node scripts/migrate/backfillObjectiveAnalysis.js [--dry-run] [--limit=N] [--concurrency=N]
 *   --dry-run        list targets, make NO LLM calls (free; run this first)
 *   --limit=N        process at most N objectives (staged rollout)
 *   --concurrency=N  parallel analyses (default 3; keep modest for LLM rate limits)
 */
require('dotenv').config();
const mongoose = require('mongoose');
const UserObjective = require('../../src/models/UserObjective');
const objectiveAnalysisService = require('../../src/services/objectiveAnalysisService');

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT_ARG = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1], 10) : Infinity;
const CONC_ARG = process.argv.find((a) => a.startsWith('--concurrency='));
const CONCURRENCY = CONC_ARG ? Math.max(1, parseInt(CONC_ARG.split('=')[1], 10)) : 3;

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) { console.error('MONGODB_URI not set'); process.exit(1); }
  await mongoose.connect(mongoUri);

  const query = {
    status: 'active',
    $or: [
      { analysis: { $exists: false } },
      { 'analysis.competencies': { $exists: false } },
      { 'analysis.competencies': { $size: 0 } },
    ],
  };
  let targets = await UserObjective.find(query).select('_id userId objectiveType').lean();
  if (LIMIT < Infinity) targets = targets.slice(0, LIMIT);

  console.log(`[analysis-backfill] active objectives missing analysis: ${targets.length}` +
    `${DRY_RUN ? ' (DRY-RUN — no LLM calls, no writes)' : ` | concurrency=${CONCURRENCY}`}`);

  if (DRY_RUN) {
    targets.forEach((t) => console.log(`  ${t._id} user=${t.userId} type=${t.objectiveType}`));
    const byType = targets.reduce((m, t) => { m[t.objectiveType] = (m[t.objectiveType] || 0) + 1; return m; }, {});
    console.log('[analysis-backfill] by type:', JSON.stringify(byType));
    console.log(`[analysis-backfill] DRY-RUN done. Would make ${targets.length} Claude Sonnet 4 calls (no assessment jobs).`);
    await mongoose.disconnect();
    return;
  }

  let ok = 0, fail = 0;
  const failures = [];
  let idx = 0;
  async function worker() {
    while (idx < targets.length) {
      const t = targets[idx++];
      try {
        const r = await objectiveAnalysisService.analyzeObjective(t._id, t.userId, { triggerAssessments: false });
        const n = r?.analysis?.competencies?.length || 0;
        ok++;
        console.log(`[analysis-backfill] ok   ${t._id} type=${t.objectiveType} competencies=${n}  (${ok + fail}/${targets.length})`);
      } catch (e) {
        fail++;
        failures.push({ id: String(t._id), err: e.message });
        console.warn(`[analysis-backfill] FAIL ${t._id}: ${e.message}  (${ok + fail}/${targets.length})`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker()));

  console.log(`[analysis-backfill] DONE ok=${ok} fail=${fail} of ${targets.length}`);
  if (failures.length) console.log('[analysis-backfill] failures:', JSON.stringify(failures.slice(0, 25)));
  await mongoose.disconnect();
}

if (require.main === module) {
  // Force clean exit — analyzeObjective pulls in BullMQ/Redis handles that keep the
  // event loop alive after disconnect().
  main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}
