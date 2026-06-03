// src/services/employer/talentAnonymizer.js
'use strict';
const ranking = require('./talentRankingService');

// Stable pseudonymous handle from the profile id. Deterministic, non-reversible to PII.
function anonHandle(id) {
  const hex = String(id || '').replace(/[^0-9a-f]/gi, '').slice(-6) || '0';
  const n = (parseInt(hex, 16) % 9000) + 1000; // 1000..9999
  return `Candidate #${n}`;
}

function _whySummary(profile) {
  const sigs = ranking.explain(profile);
  if (!sigs.length) return 'In the pool for this role.';
  return sigs.slice(0, 3).map((s) => s.label).join(' · ');
}

// Search-row card. NO name, userId, contact, or proof token.
function toBrowseCard(profile) {
  const s = profile.snapshot || {};
  return {
    handle: anonHandle(profile._id),
    roleLabel: s.roleLabel || null,
    band: s.readinessBand || null,
    score: s.readinessScore ?? null,
    target: s.target ?? null,
    achieved: !!s.achieved,
    verified: !!s.verified,
    city: profile.city || null,
    noticePeriod: profile.noticePeriod || null,
    workPref: profile.workPref || 'any',
    skills: (s.competencies || []).map((c) => c.name).slice(0, 6),
    coveragePct: s.evidence?.coveragePct ?? null,
    whySummary: _whySummary(profile),
  };
}

// Fuller anonymized profile (competency scores, evidence, full why). Still NO PII/token.
function toAnonymizedProfile(profile) {
  const s = profile.snapshot || {};
  return {
    handle: anonHandle(profile._id),
    roleLabel: s.roleLabel || null,
    objectiveType: s.objectiveType || null,
    targetCompany: s.targetCompany || null,
    band: s.readinessBand || null,
    score: s.readinessScore ?? null,
    target: s.target ?? null,
    achieved: !!s.achieved,
    verified: !!s.verified,
    city: profile.city || null,
    noticePeriod: profile.noticePeriod || null,
    workPref: profile.workPref || 'any',
    competencies: (s.competencies || []).map((c) => ({ name: c.name, score: c.score })),
    evidence: {
      assessments: s.evidence?.assessments || 0,
      capstonesGraded: s.evidence?.capstonesGraded || 0,
      interviews: s.evidence?.interviews || 0,
      coveragePct: s.evidence?.coveragePct ?? null,
    },
    codingMastery: s.codingMastery || null,
    why: ranking.explain(profile),
  };
}

module.exports = { anonHandle, toBrowseCard, toAnonymizedProfile };
