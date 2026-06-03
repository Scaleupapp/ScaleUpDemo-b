// src/services/employer/talentRankingService.js
'use strict';

// Higher = better. Developing is the floor (shouldn't appear in-pool but handled).
const BAND_RANK = { Exceptional: 3, Strong: 2, Competitive: 1, Developing: 0 };

const DAY = 24 * 60 * 60 * 1000;
function _recencyPoints(lastActiveAt) {
  if (!lastActiveAt) return 0;
  const ageDays = (Date.now() - new Date(lastActiveAt).getTime()) / DAY;
  if (ageDays <= 7) return 30;
  if (ageDays <= 30) return 15;
  if (ageDays <= 90) return 5;
  return 0;
}
function _evidenceDepth(s) {
  const e = s.evidence || {};
  const count = Math.min(40, (e.assessments || 0) + (e.capstonesGraded || 0) + (e.interviews || 0));
  const cov = typeof e.coveragePct === 'number' ? e.coveragePct : 0;
  return Math.round(cov * 0.6 + count); // 0..~100
}

// One lexicographic number: achieved > verified > band > readinessScore > evidence > recency.
// Magnitudes are separated so a higher-priority signal can never be outweighed by lower ones.
function scoreOne(profile) {
  const s = (profile && profile.snapshot) || {};
  const achieved = s.achieved ? 1 : 0;
  const verified = s.verified ? 1 : 0;
  const band = BAND_RANK[s.readinessBand] || 0;            // 0..3
  const score = Math.max(0, Math.min(100, s.readinessScore || 0)); // 0..100
  const evidence = _evidenceDepth(s);                      // 0..~100
  const recency = _recencyPoints(s.lastActiveAt);          // 0..30
  return achieved * 1e12 + verified * 1e10 + band * 1e8 + score * 1e5 + evidence * 1e2 + recency;
}

// Stable descending sort. Tie-break on a stable id so order is deterministic across calls.
function rank(profiles) {
  return [...(profiles || [])].sort((a, b) => {
    const d = scoreOne(b) - scoreOne(a);
    if (d !== 0) return d;
    return String(a && a._id || '').localeCompare(String(b && b._id || ''));
  });
}

module.exports = { BAND_RANK, scoreOne, rank };
