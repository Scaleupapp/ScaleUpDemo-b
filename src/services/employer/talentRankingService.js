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

// Evidence-backed "why this rank" — only signals that are actually present, in priority order.
function explain(profile) {
  const s = (profile && profile.snapshot) || {};
  const e = s.evidence || {};
  const out = [];
  if (s.achieved) out.push({ key: 'achieved', kind: 'good', label: 'Achieved their goal', detail: 'Reported a confirmed outcome after reaching readiness — the strongest signal there is.' });
  if (s.verified) out.push({ key: 'verified', kind: 'good', label: 'Independently verifiable', detail: 'Published a point-in-time proof badge anyone can check.' });
  if (s.readinessBand && s.readinessBand !== 'Developing') {
    const vs = typeof s.target === 'number' ? ` (${s.readinessScore} vs ${s.target} target)` : '';
    out.push({ key: 'band', kind: 'band', label: `${s.readinessBand} band${vs}`, detail: `Cleared the ${s.readinessBand} bar this role requires${vs}.` });
  }
  const count = (e.assessments || 0) + (e.capstonesGraded || 0) + (e.interviews || 0);
  if (count > 0) {
    const cov = typeof e.coveragePct === 'number' ? `, ${e.coveragePct}% of the role measured` : '';
    out.push({ key: 'evidence', kind: 'evidence', label: 'Backed by real evidence', detail: `${count} assessment${count === 1 ? '' : 's'}${cov}.` });
  }
  if (_recencyPoints(s.lastActiveAt) >= 15) out.push({ key: 'recency', kind: 'recency', label: 'Recently active', detail: 'A fresh signal — readiness reflects current ability, not a stale snapshot.' });
  return out;
}

module.exports.explain = explain;
