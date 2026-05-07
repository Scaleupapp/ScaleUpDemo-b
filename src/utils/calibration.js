'use strict';

// Spec §10.1 — score → band mapping
const BANDS = [
  { name: 'Novice',     min: 0,  max: 30,  midpoint: 15 },
  { name: 'Familiar',   min: 30, max: 55,  midpoint: 42 },
  { name: 'Proficient', min: 55, max: 80,  midpoint: 67 },
  { name: 'Expert',     min: 80, max: 101, midpoint: 90 },
];

const MIDPOINT_BY_NAME = BANDS.reduce((acc, b) => {
  acc[b.name.toLowerCase()] = b.midpoint;
  return acc;
}, {});

function clamp(n, lo, hi) {
  if (Number.isNaN(n) || n === null || n === undefined) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function scoreToBand(score) {
  const s = clamp(score, 0, 100);
  for (const b of BANDS) {
    if (s >= b.min && s < b.max) return b.name;
  }
  return 'Expert';
}

function selfRatingToMidpoint(rating) {
  if (typeof rating !== 'string') throw new Error('unknown self-rating: ' + rating);
  const m = MIDPOINT_BY_NAME[rating.toLowerCase()];
  if (m === undefined) throw new Error('unknown self-rating: ' + rating);
  return m;
}

function calibrationDelta(measuredScore, selfRating) {
  return clamp(measuredScore, 0, 100) - selfRatingToMidpoint(selfRating);
}

function calibrationClass(delta) {
  if (Math.abs(delta) <= 15) return 'well-calibrated';
  if (delta < -15) return 'overestimates';
  return 'undersells';
}

function classifyTopic({ measuredScore, selfRating }) {
  const delta = calibrationDelta(measuredScore, selfRating);
  return {
    measuredScore: clamp(measuredScore, 0, 100),
    measuredBand: scoreToBand(measuredScore),
    selfRatedMidpoint: selfRatingToMidpoint(selfRating),
    calibrationDelta: delta,
    calibrationClass: calibrationClass(delta),
  };
}

function summarizeAttempt(topicResults) {
  const classified = topicResults.map(t => ({
    canonicalName: t.canonicalName,
    ...classifyTopic({ measuredScore: t.measuredScore, selfRating: t.selfRating }),
  }));

  const wellCalibratedCount = classified.filter(t => t.calibrationClass === 'well-calibrated').length;
  const overestimatesCount  = classified.filter(t => t.calibrationClass === 'overestimates').length;
  const undersellsCount     = classified.filter(t => t.calibrationClass === 'undersells').length;

  let dominantPattern = 'mixed';
  const total = classified.length;
  if (total > 0) {
    if (wellCalibratedCount / total >= 0.6) dominantPattern = 'well-calibrated';
    else if (overestimatesCount > undersellsCount && overestimatesCount / total >= 0.5) dominantPattern = 'overestimates';
    else if (undersellsCount > overestimatesCount && undersellsCount / total >= 0.5) dominantPattern = 'undersells';
  }

  const mostStrikingTopic = classified.slice().sort(
    (a, b) => Math.abs(b.calibrationDelta) - Math.abs(a.calibrationDelta),
  )[0] || null;

  return {
    totalTopics: total,
    wellCalibratedCount,
    overestimatesCount,
    undersellsCount,
    dominantPattern,
    mostStrikingTopic,
    classifiedTopics: classified,
  };
}

module.exports = {
  scoreToBand,
  selfRatingToMidpoint,
  calibrationDelta,
  calibrationClass,
  classifyTopic,
  summarizeAttempt,
  BANDS,
};
