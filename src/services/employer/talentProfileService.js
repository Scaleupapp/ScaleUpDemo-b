// src/services/employer/talentProfileService.js
'use strict';

// Thin wrappers so tests can stub each source independently.
async function _buildProofSnapshot(userId) {
  return require('../readiness/proofService').buildSnapshot(userId);
}
async function _countInterviews(userId) {
  const InterviewSession = require('../../models/InterviewSession');
  return InterviewSession.countDocuments({ userId, status: { $in: ['completed', 'evaluated'] } }).catch(() => 0);
}
async function _getOutcomeAchieved(userId, objectiveId) {
  const ObjectiveOutcome = require('../../models/ObjectiveOutcome');
  return !!(await ObjectiveOutcome.exists({ userId, objectiveId, label: 'SUCCESS' }).catch(() => null));
}
async function _getActiveProof(userId) {
  const ReadinessProof = require('../../models/ReadinessProof');
  return ReadinessProof.findOne({ userId, active: true }).select('token').lean().catch(() => null);
}

// Build the denormalized TalentProfile.snapshot for a user's objective by REUSING the
// proof projection and augmenting it. Returns the snapshot sub-document (no DB write).
// Throws if proofService can't build (NO_OBJECTIVE / NO_SNAPSHOT) — caller guards.
async function buildTalentSnapshot(userId, objective) {
  const p = await module.exports._buildProofSnapshot(userId);
  const [interviews, achieved, proof] = await Promise.all([
    module.exports._countInterviews(userId),
    module.exports._getOutcomeAchieved(userId, objective._id),
    module.exports._getActiveProof(userId),
  ]);
  return {
    roleLabel: p.objectiveLabel,
    objectiveType: objective.objectiveType,
    targetCompany: objective.specifics?.targetCompany || null,
    readinessBand: p.band,
    readinessScore: p.score,
    target: p.target,
    competencies: (p.competencies || []).map((c) => ({ name: c.name, score: c.score })),
    evidence: {
      assessments: p.evidence?.assessments || 0,
      capstonesGraded: p.evidence?.capstonesGraded || 0,
      interviews: interviews || 0,
      coveragePct: typeof p.evidence?.coveragePct === 'number' ? p.evidence.coveragePct : null,
    },
    codingMastery: null, // populated in Phase 2 for coding-eligible objectives
    achieved: !!achieved,
    verified: !!proof,
    proofToken: proof?.token || null,
    lastActiveAt: new Date(),
  };
}

module.exports = { buildTalentSnapshot, _buildProofSnapshot, _countInterviews, _getOutcomeAchieved, _getActiveProof };
