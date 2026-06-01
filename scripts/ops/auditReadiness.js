#!/usr/bin/env node
/**
 * READ-ONLY fleet audit of readiness: for every active primary objective, recompute
 * legacy + composite exactly the way GET /api/v2/you/overview does, and report the
 * old-vs-new deltas, the guardrail's served-source distribution, and the biggest
 * outliers. Writes NOTHING. Use to sanity-check the composite flip fleet-wide.
 *
 * Run:  node scripts/ops/auditReadiness.js [--limit=N]
 */
require('dotenv').config(); // load .env BEFORE featureFlags reads process.env
const mongoose = require('mongoose');

const UserObjective = require('../../src/models/UserObjective');
const KnowledgeProfile = require('../../src/models/KnowledgeProfile');
const Plan = require('../../src/models/Plan');
const Journey = require('../../src/models/Journey');
const CompetitionProfile = require('../../src/models/CompetitionProfile');
const DiagnosticAttempt = require('../../src/models/DiagnosticAttempt');
const InterviewSession = require('../../src/models/InterviewSession');
// Register coding models so mongoose.model(...) resolves them.
require('../../src/coding/models/capstoneSession.model');
require('../../src/coding/models/drillAttempt.model');
require('../../src/coding/models/metaSkillMastery.model');

const readinessUpdater = require('../../src/coding/services/readinessUpdater');
const { evaluateCodingEligibility } = require('../../src/coding/services/codingEligibility');
const readinessService = require('../../src/services/readiness/readinessService');
const cms = require('../../src/services/readiness/competencyMasteryService');
const featureFlags = require('../../src/config/featureFlags');

const LIMIT_ARG = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1], 10) : Infinity;

// Mirror of you.js diagnosticBaselineReadiness (local, unexported there).
function diagnosticBaselineReadiness(attempt) {
  if (!attempt) return null;
  const resultsMap = attempt.results instanceof Map ? Object.fromEntries(attempt.results) : (attempt.results || {});
  const scores = Object.values(resultsMap).map((r) => (r && typeof r.score === 'number' ? r.score : null)).filter((s) => s !== null);
  if (scores.length === 0) return null;
  return Math.round(scores.reduce((s, v) => s + v, 0) / scores.length);
}

async function auditOne(objective) {
  const userId = objective.userId;
  const [knowledge, plan, journey, competition, latestAttempt] = await Promise.all([
    KnowledgeProfile.findOne({ userId }).lean(),
    Plan.findOne({ userId, status: { $in: ['active', 'ready'] } }).lean(),
    Journey.findOne({ userId, status: 'active' }).lean(),
    CompetitionProfile.findOne({ userId }).lean(),
    DiagnosticAttempt.findOne({ userId, status: 'completed' }).sort({ completedAt: -1 }).lean(),
  ]);

  // --- legacy (same as overview) ---
  let codingComponent = null;
  const elig = evaluateCodingEligibility(objective);
  try {
    if (elig.eligible) codingComponent = await readinessUpdater.getMetaSkillComponent({ user_id: userId, role_track: elig.role_track });
  } catch (_) { /* best-effort, same as overview */ }
  const diagnosticBaseline = diagnosticBaselineReadiness(latestAttempt);
  const legacy = readinessService.assembleLegacy({ plan, journey, knowledge, diagnosticBaseline, codingComponent });
  const readiness = legacy.value;

  // --- composite (same as overview) ---
  let shadow = null;
  if (objective?.analysis?.competencies?.length) {
    const now = new Date();
    const CapstoneSession = mongoose.model('CapstoneSession');
    const DrillAttempt = mongoose.model('DrillAttempt');
    const MetaSkillMastery = mongoose.model('MetaSkillMastery');
    const [capstones, drills, mastery, interviews] = await Promise.all([
      elig.eligible ? CapstoneSession.find({ user_id: userId, status: 'graded' }).select('result.overall_score graded_at').sort({ graded_at: -1 }).limit(10).lean() : [],
      elig.eligible ? DrillAttempt.find({ user_id: userId, status: 'graded' }).select('grade.overall_score submitted_at').sort({ submitted_at: -1 }).limit(20).lean() : [],
      elig.eligible ? MetaSkillMastery.findOne({ user_id: userId, role_track: elig.role_track }).lean() : null,
      InterviewSession.find({ userId, status: { $in: ['completed', 'evaluated'] } }).select('evaluation.overallScore completedAt').sort({ completedAt: -1 }).limit(10).lean(),
    ]);
    const codingSignal = elig.eligible ? cms.buildCodingSignal({ capstones, drills, mastery, now }) : null;
    const interviewSignal = cms.buildInterviewSignal({ interviews, now });
    const behavioral = cms.buildBehavioralSignal({ streak: competition?.currentStreak || 0, contentCompleted: 0, activeDays7: 0 });
    const composite = readinessService.computeComposite({ objective, ctx: { coding: !!elig.eligible }, knowledge, codingSignal, interviewSignal, behavioral, now });
    if (composite) shadow = { value: composite.value, confidence: composite.confidence, coverage: composite.coverage, delta: composite.value - readiness };
  }

  const served = readinessService.chooseServed({ legacyValue: readiness, shadow, flagOn: featureFlags.compositeReadiness });
  return {
    userId: String(userId),
    objectiveType: objective.objectiveType,
    analyzed: !!objective?.analysis?.competencies?.length,
    tmCount: (knowledge?.topicMastery || []).length,
    compCount: (objective?.analysis?.competencies || []).length,
    legacy: readiness,
    composite: shadow ? shadow.value : null,
    delta: shadow ? shadow.delta : null,
    confidence: shadow ? Math.round(shadow.confidence * 1000) / 1000 : null,
    coverage: shadow ? Math.round(shadow.coverage * 1000) / 1000 : null,
    served: served.value,
    servedSource: served.source,
  };
}

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) { console.error('MONGODB_URI not set'); process.exit(1); }
  await mongoose.connect(mongoUri);

  const objectives = await UserObjective.find({ status: 'active', isPrimary: true }).lean();
  console.log(`[audit] flagOn(composite)=${featureFlags.compositeReadiness} active primary objectives=${objectives.length}`);

  const rows = [];
  let n = 0;
  for (const obj of objectives) {
    if (n >= LIMIT) break;
    n++;
    try { rows.push(await auditOne(obj)); }
    catch (e) { console.warn(`[audit] user=${obj.userId} skipped: ${e.message}`); }
  }

  const withComp = rows.filter((r) => r.composite !== null);
  const noComp = rows.filter((r) => r.composite === null);
  const analyzed = rows.filter((r) => r.analyzed);
  const analyzedNoSignal = rows.filter((r) => r.analyzed && r.composite === null);
  const unanalyzed = rows.filter((r) => !r.analyzed);
  const deltas = withComp.map((r) => r.delta);
  const abs = deltas.map((d) => Math.abs(d));
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  const mean = (a) => (a.length ? Math.round((sum(a) / a.length) * 10) / 10 : null);
  const sorted = [...deltas].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  const bucket = (lo, hi) => abs.filter((d) => d >= lo && d < hi).length;

  const bySource = rows.reduce((m, r) => { m[r.servedSource] = (m[r.servedSource] || 0) + 1; return m; }, {});

  console.log('\n===== READINESS FLEET AUDIT =====');
  console.log(`objectives audited:        ${rows.length}`);
  console.log(`  analyzed (framework exists):  ${analyzed.length}`);
  console.log(`    -> produces a composite:    ${withComp.length}`);
  console.log(`    -> analyzed but NO signal:  ${analyzedNoSignal.length}`);
  const noSignalNoData = analyzedNoSignal.filter((r) => r.tmCount === 0).length;
  const noSignalHasData = analyzedNoSignal.filter((r) => r.tmCount > 0).length;
  console.log(`         of which NO data at all (empty topicMastery): ${noSignalNoData}  -> needs assessments/engagement`);
  console.log(`         of which HAS data but names don't match:      ${noSignalHasData}  -> needs name reconciliation`);
  console.log(`  un-analyzed (no framework):   ${unanalyzed.length}`);
  console.log('\n--- served source (what users actually get) ---');
  Object.entries(bySource).forEach(([k, v]) => console.log(`  ${k.padEnd(10)} ${v}`));
  console.log('\n--- composite-vs-legacy delta (analyzed users) ---');
  console.log(`  mean=${mean(deltas)}  median=${median}  min=${sorted[0]}  max=${sorted[sorted.length - 1]}`);
  console.log(`  |delta| 0-5:${bucket(0, 6)}  6-10:${bucket(6, 11)}  11-15:${bucket(11, 16)}  16+:${abs.filter((d) => d >= 16).length}`);
  console.log(`  confidence mean=${mean(withComp.map((r) => r.confidence))}  coverage mean=${mean(withComp.map((r) => r.coverage))}`);

  console.log('\n--- top 12 outliers by |delta| ---');
  [...withComp].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 12).forEach((r) => {
    console.log(`  ${r.userId}  ${String(r.objectiveType).slice(0, 12).padEnd(12)} legacy=${String(r.legacy).padStart(3)} comp=${String(r.composite).padStart(3)} d=${String(r.delta).padStart(4)} conf=${r.confidence} cov=${r.coverage} -> ${r.servedSource}`);
  });
  console.log('\n[audit] done (read-only, no writes).');
  await mongoose.disconnect();
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}
