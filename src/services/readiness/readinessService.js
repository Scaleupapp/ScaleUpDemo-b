'use strict';

/**
 * Single source of truth for the readiness number. Phase 0: assembleLegacy
 * reproduces the existing overview computation EXACTLY (waterfall + bounded
 * coding blend). Phase 1 adds computeComposite (shadow). All callers
 * (you.js overview, Compass coach context) should route through here.
 */

const mongoose = require('mongoose');
const ReadinessSnapshot = require('../../models/ReadinessSnapshot');

/** Mirror of the overview's knowledge fallback (do not change semantics). */
function computeReadinessFromKnowledge(knowledge) {
  if (!knowledge) return null;
  if (typeof knowledge.overallScore === 'number' && knowledge.overallScore > 0) {
    return Math.round(knowledge.overallScore);
  }
  if (Array.isArray(knowledge.topicMastery) && knowledge.topicMastery.length > 0) {
    const sum = knowledge.topicMastery.reduce((s, t) => s + (t.score || 0), 0);
    return Math.round(sum / knowledge.topicMastery.length);
  }
  if (knowledge.topicProfiles) {
    const entries = Object.values(knowledge.topicProfiles);
    if (entries.length > 0) {
      const avg = entries.reduce((s, t) => s + (t.masteryLevel || 0), 0) / entries.length;
      return Math.round(avg);
    }
  }
  return null;
}

/**
 * Reproduce today's served readiness, byte-for-byte.
 * @param {{ plan?, journey?, knowledge?, codingComponent?: {value:number,weight:number,attempt_count:number} }} inputs
 * @returns {{ value:number, source:string, coding: object|null }}
 */
function assembleLegacy({ plan, journey, knowledge, diagnosticBaseline, codingComponent } = {}) {
  let value;
  let source;
  if (plan && typeof plan.readinessScore === 'number') { value = plan.readinessScore; source = 'plan'; }
  else if (journey && typeof journey.readinessScore === 'number') { value = journey.readinessScore; source = 'journey'; }
  else {
    const k = computeReadinessFromKnowledge(knowledge);
    if (typeof k === 'number') { value = k; source = 'knowledge'; }
    // Fresh, just-onboarded users have an empty KnowledgeProfile but DO have a
    // diagnostic baseline. The Plan screen already shows this; the Home ring
    // showed 0 because it never read it. Fall back to it so Home matches Plan.
    else if (typeof diagnosticBaseline === 'number') { value = diagnosticBaseline; source = 'diagnostic'; }
    else { value = 0; source = 'floor'; }
  }

  let coding = null;
  if (codingComponent && codingComponent.weight > 0 && value > 0) {
    const w = codingComponent.weight;
    value = Math.max(0, Math.min(100, Math.round(value * (1 - w) + codingComponent.value * w)));
    coding = {
      value: Math.round(codingComponent.value),
      weight: Number(w.toFixed(3)),
      attempt_count: codingComponent.attempt_count,
    };
  }
  return { value, source, coding };
}

/**
 * Best-effort persist. NEVER throws — readiness history must not gate the
 * overview response.
 * @param {{userId, objectiveId?, value, source, breakdown?, shadow?}} snap
 */
async function persistSnapshot(snap) {
  try {
    await ReadinessSnapshot.create({
      userId: snap.userId,
      objectiveId: snap.objectiveId,
      value: snap.value,
      source: snap.source,
      breakdown: snap.breakdown,
      shadow: snap.shadow,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[readinessService.persistSnapshot] skipped:', err.message);
  }
}

/**
 * Multi-primitive, objective-weighted composite readiness (Robust Rule B).
 * Pure: takes already-fetched signals. Returns null if the objective has no
 * competency framework (so callers fall back to legacy).
 * @returns {{value:number, confidence:number, behavioralModifier:number, breakdown:Array}|null}
 */
function computeComposite({ objective, ctx, knowledge, codingSignal, interviewSignal, behavioral, now = new Date() }) {
  const comps = objective?.analysis?.competencies;
  if (!Array.isArray(comps) || comps.length === 0) return null;
  // Lazy-required so readinessService loads even before competencyMasteryService exists.
  const competencyMastery = require('./competencyMasteryService');

  let wSum = 0, sSum = 0, cSum = 0;       // over ASSESSED competencies only
  let totalWeight = 0, assessedWeight = 0;
  const breakdown = [];
  for (const comp of comps) {
    const w = typeof comp.weight === 'number' && comp.weight > 0 ? comp.weight : 5;
    totalWeight += w;
    const m = competencyMastery.computeCompetencyMastery({
      competency: comp, ctx: ctx || { coding: false }, knowledge, codingSignal, interviewSignal, now,
    });
    breakdown.push({
      competency: comp.name, weight: w, primitive: m.primitive,
      score: m.score, confidence: m.confidence, assessed: m.confidence > 0,
    });
    // Only competencies with ACTUAL evidence contribute to the score. An
    // unassessed competency must NOT count as a 0 (that punishes coverage gaps
    // and makes the composite understate a real user); instead it lowers
    // `coverage`, which lowers overall confidence so the guardrail keeps serving
    // legacy until enough of the objective is genuinely measured.
    if (m.confidence > 0) {
      wSum += w; sSum += m.score * w; cSum += m.confidence * w;
      assessedWeight += w;
    }
  }
  if (wSum === 0) return null; // nothing assessed yet — legacy serves
  const weighted = sSum / wSum;
  const coverage = totalWeight > 0 ? assessedWeight / totalWeight : 0;
  const modifier = behavioral?.modifier || 0;
  const value = Math.max(0, Math.min(100, Math.round(weighted + modifier)));
  // Blend evidence depth with coverage so a partially-assessed objective stays
  // low-confidence (and thus keeps serving legacy) even when the measured slice
  // scores high.
  const confidence = Number(((cSum / wSum) * coverage).toFixed(3));
  return { value, confidence, coverage: Number(coverage.toFixed(3)), behavioralModifier: modifier, breakdown };
}

// Confidence guardrail thresholds. Below MIN we don't trust the composite at
// all (cold-start / thin evidence) and serve legacy; between MIN and FULL we
// blend proportionally so the number never jumps off a cliff; above FULL we
// serve the composite outright.
const CONFIDENCE_MIN = 0.35;
const CONFIDENCE_FULL = 0.7;

/**
 * Decide what to actually SERVE, given the legacy value and the shadow composite.
 * This is the safety net that makes flipping the flag safe even before we've
 * tuned weights: thin-evidence users keep their legacy number, well-evidenced
 * users get the composite, and the middle blends — so nobody sees a sudden drop.
 *
 * @param {{ legacyValue:number, shadow:{value:number,confidence:number}|null, flagOn:boolean }} args
 * @returns {{ value:number, source:'legacy'|'legacy_lowconf'|'blend'|'composite' }}
 */
function chooseServed({ legacyValue, shadow, flagOn }) {
  if (!flagOn || !shadow || typeof shadow.value !== 'number') {
    return { value: legacyValue, source: 'legacy' };
  }
  const conf = typeof shadow.confidence === 'number' ? shadow.confidence : 0;
  if (conf < CONFIDENCE_MIN) {
    return { value: legacyValue, source: 'legacy_lowconf' };
  }
  if (conf < CONFIDENCE_FULL) {
    const w = (conf - CONFIDENCE_MIN) / (CONFIDENCE_FULL - CONFIDENCE_MIN); // 0..1
    return { value: Math.round(legacyValue * (1 - w) + shadow.value * w), source: 'blend' };
  }
  return { value: shadow.value, source: 'composite' };
}

/**
 * Has the learner reached "Ready"? True only when the SERVED readiness is
 * composite- or blend-backed (trustworthy past the guardrail) AND meets the
 * effective target. Legacy/thin-evidence users never qualify — keeps the moment
 * (and 3B's proof) credible.
 */
function evaluateReady({ servedSource, servedValue, target } = {}) {
  if (servedSource !== 'composite' && servedSource !== 'blend') return false;
  if (typeof target !== 'number' || target <= 0) return false;
  if (typeof servedValue !== 'number') return false;
  return servedValue >= target;
}

/**
 * Inline of the diagnosticBaselineReadiness helper from routes/v2/you.js.
 * Kept here so getServedReadiness can use it without a circular dep.
 */
function _diagnosticBaselineReadiness(attempt) {
  if (!attempt) return null;
  const resultsMap = attempt.results instanceof Map
    ? Object.fromEntries(attempt.results)
    : (attempt.results || {});
  const scores = Object.values(resultsMap)
    .map((r) => (r && typeof r.score === 'number' ? r.score : null))
    .filter((s) => s !== null);
  if (scores.length === 0) return null;
  return Math.round(scores.reduce((s, v) => s + v, 0) / scores.length);
}

/**
 * The single served-readiness composition used by BOTH /you/overview and Compass.
 * Mirrors the inline logic in routes/v2/you.js so the number never drifts.
 * Returns { value, source, target, targetBands, breakdown|null, coverage|null, coding|null, draggers[] }.
 */
async function getServedReadiness(userId) {
  const UserObjective = mongoose.model('UserObjective');
  const Plan = mongoose.model('Plan');
  const Journey = mongoose.model('Journey');
  const KnowledgeProfile = mongoose.model('KnowledgeProfile');
  const CompetitionProfile = mongoose.model('CompetitionProfile');
  const InterviewSession = mongoose.model('InterviewSession');
  const DiagnosticAttempt = mongoose.model('DiagnosticAttempt');
  const targetService = require('./targetService');
  const featureFlags = require('../../config/featureFlags');
  const { evaluateCodingEligibility } = require('../../coding/services/codingEligibility');
  const readinessUpdater = require('../../coding/services/readinessUpdater');

  const [objective, plan, journey, knowledge, competition, latestAttempt] = await Promise.all([
    UserObjective.findOne({ userId, status: 'active', isPrimary: true }).lean(),
    Plan.findOne({ userId, isActive: true }).lean(),
    Journey.findOne({ userId, status: 'active' }).lean(),
    KnowledgeProfile.findOne({ userId }).lean(),
    CompetitionProfile.findOne({ userId }).lean(),
    DiagnosticAttempt.findOne({ userId, status: 'completed' }).sort({ completedAt: -1 }).lean(),
  ]);

  let codingComponent = null;
  try {
    const elig = evaluateCodingEligibility(objective);
    if (elig.eligible) {
      codingComponent = await readinessUpdater.getMetaSkillComponent({ user_id: userId, role_track: elig.role_track });
    }
  } catch (_) {}

  const diagnosticBaseline = _diagnosticBaselineReadiness(latestAttempt);
  const legacy = assembleLegacy({ plan, journey, knowledge, diagnosticBaseline, codingComponent });
  const legacyValue = legacy.value;

  let shadow = null;
  try {
    if (objective?.analysis?.competencies?.length) {
      const cms = require('./competencyMasteryService');
      const elig = evaluateCodingEligibility(objective);
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
      const composite = computeComposite({ objective, ctx: { coding: !!elig.eligible }, knowledge, codingSignal, interviewSignal, behavioral, now });
      if (composite) {
        shadow = { value: composite.value, confidence: composite.confidence, coverage: composite.coverage, breakdown: composite.breakdown, delta: composite.value - legacyValue };
      }
    }
  } catch (_) {}

  const served = chooseServed({ legacyValue, shadow, flagOn: featureFlags.compositeReadiness });
  const effectiveTarget = targetService.getEffectiveTarget(objective);
  const targetBands = targetService.targetBands(effectiveTarget);

  const breakdown = Array.isArray(shadow?.breakdown)
    ? shadow.breakdown
        .map((b) => ({ name: b.competency, weight: b.weight, score: b.score, assessed: !!b.assessed, primitive: b.primitive }))
        .sort((a, b) => b.weight - a.weight)
    : null;

  let draggers;
  if (breakdown && (served.source === 'composite' || served.source === 'blend')) {
    draggers = breakdown.filter((b) => b.assessed).sort((a, b) => a.score - b.score).slice(0, 3).map((b) => ({ name: b.name, score: b.score }));
  } else {
    draggers = (knowledge?.topicMastery || []).filter((t) => typeof t.score === 'number').sort((a, b) => a.score - b.score).slice(0, 3).map((t) => ({ name: t.topic, score: t.score }));
  }

  return { value: served.value, source: served.source, target: effectiveTarget, targetBands, breakdown, coverage: shadow?.coverage ?? null, coding: legacy.coding || null, draggers };
}

module.exports = {
  assembleLegacy,
  computeReadinessFromKnowledge,
  persistSnapshot,
  computeComposite,
  chooseServed,
  evaluateReady,
  getServedReadiness,
  CONFIDENCE_MIN,
  CONFIDENCE_FULL,
};
