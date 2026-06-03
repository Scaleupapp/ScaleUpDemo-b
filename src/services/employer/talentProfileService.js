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

const { isEligible } = require('./talentEligibilityService');

async function _getPrimaryObjective(userId) {
  const UserObjective = require('../../models/UserObjective');
  return UserObjective.findOne({ userId, status: 'active', isPrimary: true }).lean();
}
async function _upsertProfile(userId, objectiveId, patch) {
  const TalentProfile = require('../../models/TalentProfile');
  return TalentProfile.updateOne({ userId, objectiveId }, { $set: patch }, { upsert: true });
}

function _evidenceCount(snap) {
  const e = snap.evidence || {};
  return (e.assessments || 0) + (e.capstonesGraded || 0) + (e.interviews || 0);
}

// Candidate opts in. Resolves their primary objective, builds the snapshot, gates on
// eligibility, and upserts an active TalentProfile. `prefs` = { city, noticePeriod, workPref }.
async function optIn(userId, prefs = {}) {
  const objective = await module.exports._getPrimaryObjective(userId);
  if (!objective) throw new Error('NO_OBJECTIVE');
  const snapshot = await module.exports.buildTalentSnapshot(userId, objective);
  if (!isEligible({ objectiveType: snapshot.objectiveType, evidenceCount: _evidenceCount(snapshot) })) {
    throw new Error('NOT_ELIGIBLE');
  }
  const patch = {
    optedIn: true, optedInAt: new Date(), status: 'active', snapshot, refreshedAt: new Date(),
    ...(prefs.city != null ? { city: prefs.city } : {}),
    ...(prefs.noticePeriod != null ? { noticePeriod: prefs.noticePeriod } : {}),
    ...(prefs.workPref != null ? { workPref: prefs.workPref } : {}),
  };
  await module.exports._upsertProfile(userId, objective._id, patch);
  return { ok: true };
}

// Candidate withdraws — pause (keeps the row + prefs but drops out of search).
async function optOut(userId) {
  const objective = await module.exports._getPrimaryObjective(userId);
  if (!objective) return { ok: true };
  await module.exports._upsertProfile(userId, objective._id, { optedIn: false, status: 'paused' });
  return { ok: true };
}

// Rebuild the snapshot for an already-opted-in candidate (called on readiness/outcome/proof
// change in later phases). No-op if not opted in.
async function refresh(userId) {
  const objective = await module.exports._getPrimaryObjective(userId);
  if (!objective) return { ok: false };
  const TalentProfile = require('../../models/TalentProfile');
  const existing = await TalentProfile.findOne({ userId, objectiveId: objective._id }).select('optedIn').lean();
  if (!existing || !existing.optedIn) return { ok: false };
  const snapshot = await module.exports.buildTalentSnapshot(userId, objective);
  await module.exports._upsertProfile(userId, objective._id, { snapshot, refreshedAt: new Date() });
  return { ok: true };
}

module.exports.optIn = optIn;
module.exports.optOut = optOut;
module.exports.refresh = refresh;
module.exports._getPrimaryObjective = _getPrimaryObjective;
module.exports._upsertProfile = _upsertProfile;
