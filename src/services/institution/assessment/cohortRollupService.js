'use strict';
// Recompute + upsert the cached analytics rollup for an assessment AND the
// cohort-wide (assessmentId:null) rollup. Pure aggregation over AssessmentSession;
// safe to re-run.
//
// Cohort-wide approach (Wave 3 block 3): the cohort-wide (assessmentId:null) doc
// is (re)computed on EACH per-assessment recompute by aggregating every session
// in the cohort. Chosen over live endpoint-side aggregation because analytics.js
// and the rollup endpoint already read this cached null doc, and recompute is the
// single write-path fired on every grade — so piggybacking is the simplest
// correct fix with no new read-path cost. (The extra work is one find + one
// upsert per grade; the alternative would re-scan on every dashboard load.)

const {
  summarizeIntegrity, scoreMethodForSessions,
} = require('./assessmentIntegrityService');

// byCompetency reads each session's OWN engine type, so a cohort-wide rollup that
// mixes engines aggregates each session under its correct shape.
function computeByCompetency(gradedSessions) {
  const acc = {}; // name -> { sum, n }
  for (const s of gradedSessions) {
    const raw = s.result && s.result.raw;
    if (!raw) continue;
    const engineType = s.engine && s.engine.type;
    if (!engineType) continue;
    if (engineType === 'mcq') {
      const breakdown = raw.competencyBreakdown;
      if (!Array.isArray(breakdown)) continue;
      for (const entry of breakdown) {
        if (!entry || typeof entry.percentage !== 'number') continue;
        const name = entry.competency || 'unknown';
        if (!acc[name]) acc[name] = { sum: 0, n: 0 };
        acc[name].sum += entry.percentage;
        acc[name].n += 1;
      }
    } else if (engineType === 'interview') {
      const dims = raw.dimensions;
      if (!dims || typeof dims !== 'object') continue;
      for (const [dim, val] of Object.entries(dims)) {
        if (!val || typeof val.score !== 'number') continue;
        if (!acc[dim]) acc[dim] = { sum: 0, n: 0 };
        acc[dim].sum += val.score;
        acc[dim].n += 1;
      }
    } else if (engineType === 'capstone') {
      const dimScores = raw.dimension_scores;
      if (!dimScores || typeof dimScores !== 'object') continue;
      for (const [dim, val] of Object.entries(dimScores)) {
        if (typeof val !== 'number') continue;
        if (!acc[dim]) acc[dim] = { sum: 0, n: 0 };
        acc[dim].sum += val * 10; // scale 0-10 → 0-100
        acc[dim].n += 1;
      }
    } else if (engineType === 'drill') {
      const breakdown = raw.rubric_breakdown;
      if (!Array.isArray(breakdown)) continue;
      for (const entry of breakdown) {
        if (!entry || typeof entry.score !== 'number') continue;
        const name = entry.dimension || 'unknown';
        if (!acc[name]) acc[name] = { sum: 0, n: 0 };
        acc[name].sum += entry.score;
        acc[name].n += 1;
      }
    }
  }
  return Object.entries(acc).map(([name, { sum, n }]) => ({ name, avgScore: Math.round(sum / n), n }));
}

// Build the rollup document for one scope (a single assessment, or the whole
// cohort when assessmentId is null). Pure — takes the already-fetched sessions.
function buildRollupDoc({ institutionId, cohortId, assessmentId, sessions, assigned, now }) {
  const started = sessions.filter((s) => s.status !== 'scheduled');
  const graded = sessions.filter((s) => s.status === 'graded');
  const scores = graded.map((s) => s.result && s.result.score).filter((n) => typeof n === 'number');
  const scoreMethod = scoreMethodForSessions(sessions);
  // Review I2: never serve a number that blends objective MCQ % with AI-judged
  // scores — the cohort-wide multi-engine rollup gets no avgScore at all.
  const avgScore = (scoreMethod !== 'mixed' && scores.length)
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    : undefined;

  // Integrity truth (Wave 3 block 4): checked/flagged/unproctored over the
  // STARTED sessions. integrityFlags is retained for backward-compat but now
  // derives ONLY from real flags (== integrity.flaggedCount) — no fabrication.
  const integrity = summarizeIntegrity(started);

  // Honest lifecycle buckets (Wave 3 block 2). submitted = reached submission
  // (submitted OR graded) — backed by a real submittedAt. expired is distinct.
  const counts = {
    assigned,
    started: started.length,
    submitted: sessions.filter((s) => ['submitted', 'graded'].includes(s.status)).length,
    graded: graded.length,
    expired: sessions.filter((s) => s.status === 'expired').length,
  };

  const byCompetency = computeByCompetency(graded);

  return {
    institutionId, cohortId, assessmentId,
    computedAt: now,
    counts, avgScore, gradedCount: scores.length,
    // Per-engine score framing so UIs never cross-average objective % with
    // AI-judged scores. 'mixed' on the cohort-wide (multi-engine) rollup.
    scoreMethod,
    integrity, integrityFlags: integrity.flaggedCount,
    byCompetency,
  };
}

async function recompute(institutionId, cohortId, assessmentId, deps = {}) {
  const AssessmentSession = deps.AssessmentSession || require('../../../models/AssessmentSession');
  const CohortRollup = deps.CohortRollup || require('../../../models/CohortRollup');
  const InstitutionEnrollment = deps.InstitutionEnrollment || require('../../../models/InstitutionEnrollment');
  const now = (deps.now && deps.now()) || new Date();

  // assigned = cohort enrollment count (not session count) — same for both scopes.
  const assigned = await InstitutionEnrollment.countDocuments({ cohortId, status: { $ne: 'withdrawn' } });

  // Cohort-wide (assessmentId:null) rollup FIRST, so the per-assessment upsert is
  // the last CohortRollup write (keeps single-write-capturing tests meaningful).
  try {
    const allSessions = await AssessmentSession.find({ institutionId, cohortId });
    const wideDoc = buildRollupDoc({ institutionId, cohortId, assessmentId: null, sessions: allSessions, assigned, now });
    await CohortRollup.findOneAndUpdate(
      { institutionId, cohortId, assessmentId: null },
      { $set: wideDoc },
      { upsert: true, new: true },
    );
  } catch (e) {
    console.warn('[cohortRollup] cohort-wide recompute failed', e.message);
  }

  // Per-assessment rollup.
  const sessions = await AssessmentSession.find({ institutionId, cohortId, assessmentId });
  const doc = buildRollupDoc({ institutionId, cohortId, assessmentId, sessions, assigned, now });
  await CohortRollup.findOneAndUpdate(
    { institutionId, cohortId, assessmentId },
    { $set: doc },
    { upsert: true, new: true },
  );
  return doc;
}

module.exports = { recompute, computeByCompetency, buildRollupDoc };
