'use strict';

const { assessmentTypesToPrimitive } = require('./primitiveMap');

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Signal aggregators ───────────────────────────────────────────────────────

/** Coding signal: blend recent capstone/drill scores with mastery-axis average. */
function buildCodingSignal({ capstones = [], drills = [], mastery = null, now = new Date() }) {
  const events = [
    ...capstones.map((c) => ({ score: c.result?.overall_score, at: c.graded_at, weightK: 1.5 })), // capstones weigh more
    ...drills.map((d) => ({ score: d.grade?.overall_score, at: d.submitted_at, weightK: 1.0 })),
  ].filter((e) => typeof e.score === 'number');

  const count = events.length;
  let score = 0;
  let lastAt = null;
  if (count > 0) {
    let wSum = 0, sSum = 0;
    for (const e of events) {
      const w = e.weightK;
      wSum += w; sSum += e.score * w;
      if (!lastAt || new Date(e.at) > lastAt) lastAt = new Date(e.at);
    }
    score = sSum / wSum;
  } else if (mastery?.axes) {
    const a = mastery.axes;
    score = ((a.prompting || 0) + (a.verification || 0) + (a.decomposition || 0) + (a.refactoring || 0)) / 4;
  }
  return { score: Math.round(score), count, lastAt, hasDifficulty: count > 0 };
}

/** Interview signal: recency-weighted average of evaluation.overallScore. */
function buildInterviewSignal({ interviews = [], now = new Date() }) {
  const events = interviews
    .map((i) => ({ score: i.evaluation?.overallScore, at: i.completedAt }))
    .filter((e) => typeof e.score === 'number');
  const count = events.length;
  let score = 0, lastAt = null;
  if (count > 0) {
    let wSum = 0, sSum = 0;
    for (const e of events) {
      const ageDays = Math.max(0, (now - new Date(e.at)) / DAY_MS);
      const w = Math.max(0.3, 1 - ageDays / 120); // linear recency weight, floor 0.3
      wSum += w; sSum += e.score * w;
      if (!lastAt || new Date(e.at) > lastAt) lastAt = new Date(e.at);
    }
    score = sSum / wSum;
  }
  return { score: Math.round(score), count, lastAt };
}

/** Behavioral momentum -> a small bounded modifier in [-5, +5]. Not skill. */
function buildBehavioralSignal({ streak = 0, contentCompleted = 0, activeDays7 = 0 } = {}) {
  // Normalize each to 0..1, average, map to [-5, +5] centered so "average" ~ 0.
  const s = Math.min(1, streak / 30);          // 30-day streak = full
  const c = Math.min(1, contentCompleted / 20); // 20 lessons = full
  const a = Math.min(1, activeDays7 / 7);       // 7/7 active days = full
  const composite = (s + c + a) / 3;            // 0..1
  const modifier = Math.round((composite - 0.5) * 10); // -5..+5
  return { modifier: Math.max(-5, Math.min(5, modifier)), composite };
}

// ── Recency + confidence ─────────────────────────────────────────────────────

/** 1.0 at now, decays linearly to a 0.5 floor by 90 days. null -> floor. */
function recencyFactor(lastAt, now = new Date()) {
  if (!lastAt) return 0.5;
  const ageDays = Math.max(0, (now - new Date(lastAt)) / DAY_MS);
  return Math.max(0.5, 1 - 0.5 * (ageDays / 90));
}

/** Evidence confidence in [0,1] from count, recency factor, and difficulty. */
function confidenceFrom({ count = 0, recency = 0.5, hasDifficulty = false }) {
  const volume = Math.min(1, count / 4);            // 4+ assessments = full volume confidence
  const diff = hasDifficulty ? 1 : 0.7;             // difficulty-graded evidence is more trustworthy
  const c = volume * recency * diff;
  return Math.max(0, Math.min(1, Number(c.toFixed(3))));
}

// ── Per-competency mastery ───────────────────────────────────────────────────

/** Fuzzy topic match (same spirit as objectiveAnalysisService): name-overlap. */
function matchTopicMastery(name, topicMastery = []) {
  const key = String(name || '').toLowerCase();
  let best = null;
  for (const t of topicMastery) {
    const topic = String(t.topic || '').toLowerCase();
    if (topic === key || topic.includes(key) || key.includes(topic)) {
      if (!best || (t.score || 0) > (best.score || 0)) best = t;
    }
  }
  return best;
}

/**
 * Per-competency mastery from its mapped primitive.
 * @returns {{score:number, confidence:number, primitive:string}}
 */
function computeCompetencyMastery({ competency, ctx, knowledge, codingSignal, interviewSignal, now = new Date() }) {
  const primitive = assessmentTypesToPrimitive(competency.assessmentTypes, ctx);

  // PRIMARY: per-competency quiz topic-mastery. The app generates a skill
  // assessment PER competency, so topicMastery is keyed by competency name and is
  // the most granular, accurate signal. Always prefer it when present — a generic
  // coding/interview AGGREGATE (one number smeared across many competencies) must
  // never override a real per-competency score.
  const tm = matchTopicMastery(competency.name, knowledge?.topicMastery);
  if (tm && typeof tm.score === 'number') {
    const rec = recencyFactor(tm.lastAssessedAt, now);
    return {
      primitive: 'quiz',
      score: Math.round(tm.score * rec),
      confidence: confidenceFrom({ count: tm.quizzesTaken || 1, recency: rec, hasDifficulty: false }),
    };
  }

  // FALLBACK (no per-competency quiz yet): use the mapped primitive's aggregate.
  // Coding only for genuinely coding-eligible objectives (ctx.coding).
  if (primitive === 'coding' && ctx && ctx.coding && codingSignal && codingSignal.count > 0) {
    const rec = recencyFactor(codingSignal.lastAt, now);
    return {
      primitive: 'coding',
      score: Math.round(codingSignal.score * rec),
      confidence: confidenceFrom({ count: codingSignal.count, recency: rec, hasDifficulty: codingSignal.hasDifficulty }),
    };
  }
  if (primitive === 'interview' && interviewSignal && interviewSignal.count > 0) {
    const rec = recencyFactor(interviewSignal.lastAt, now);
    return {
      primitive: 'interview',
      score: Math.round(interviewSignal.score * rec),
      confidence: confidenceFrom({ count: interviewSignal.count, recency: rec, hasDifficulty: false }),
    };
  }
  return { primitive, score: 0, confidence: 0 };
}

module.exports = {
  buildCodingSignal,
  buildInterviewSignal,
  buildBehavioralSignal,
  recencyFactor,
  confidenceFrom,
  matchTopicMastery,
  computeCompetencyMastery,
};
