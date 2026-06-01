'use strict';

/**
 * Single source of truth for the readiness number. Phase 0: assembleLegacy
 * reproduces the existing overview computation EXACTLY (waterfall + bounded
 * coding blend). Phase 1 adds computeComposite (shadow). All callers
 * (you.js overview, Compass coach context) should route through here.
 */

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

  let wSum = 0, sSum = 0, cSum = 0;
  const breakdown = [];
  for (const comp of comps) {
    const w = typeof comp.weight === 'number' && comp.weight > 0 ? comp.weight : 5;
    const m = competencyMastery.computeCompetencyMastery({
      competency: comp, ctx: ctx || { coding: false }, knowledge, codingSignal, interviewSignal, now,
    });
    wSum += w; sSum += m.score * w; cSum += m.confidence * w;
    breakdown.push({ competency: comp.name, weight: w, primitive: m.primitive, score: m.score, confidence: m.confidence });
  }
  if (wSum === 0) return null;
  const weighted = sSum / wSum;
  const modifier = behavioral?.modifier || 0;
  const value = Math.max(0, Math.min(100, Math.round(weighted + modifier)));
  const confidence = Number((cSum / wSum).toFixed(3));
  return { value, confidence, behavioralModifier: modifier, breakdown };
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

module.exports = {
  assembleLegacy,
  computeReadinessFromKnowledge,
  persistSnapshot,
  computeComposite,
  chooseServed,
  CONFIDENCE_MIN,
  CONFIDENCE_FULL,
};
