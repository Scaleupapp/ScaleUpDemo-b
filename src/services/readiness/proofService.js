'use strict';
const UserObjective = require('../../models/UserObjective');
const ReadinessSnapshot = require('../../models/ReadinessSnapshot');
const User = require('../../models/User');
const { getEffectiveTarget, targetBands } = require('./targetService');

function bandFor(score, bands) {
  if (score >= bands.exceptional) return 'Exceptional';
  if (score >= bands.strong) return 'Strong';
  if (score >= bands.competitive) return 'Competitive';
  return 'Developing';
}

// Cheap evidence counts. Overridable in tests via proofService._countEvidence.
async function _countEvidence(userId) {
  const QuizAttempt = require('../../models/QuizAttempt');
  const InterviewSession = require('../../models/InterviewSession');
  const CapstoneSession = require('../../coding/models/capstoneSession.model');
  const [quizzes, interviews, capstones] = await Promise.all([
    QuizAttempt.countDocuments({ userId }).catch(() => 0),
    InterviewSession.countDocuments({ userId, status: { $in: ['completed', 'evaluated'] } }).catch(() => 0),
    CapstoneSession.countDocuments({ user_id: userId, status: 'graded' }).catch(() => 0),
  ]);
  return { assessments: quizzes + interviews + capstones, capstonesGraded: capstones, hoursInvested: 0 };
}

async function buildSnapshot(userId) {
  const objective = await UserObjective.findOne({ userId, status: 'active', isPrimary: true }).lean();
  if (!objective) throw new Error('NO_OBJECTIVE');
  const snap = await ReadinessSnapshot.findOne({ userId, objectiveId: objective._id }).sort({ createdAt: -1 }).lean();
  if (!snap) throw new Error('NO_SNAPSHOT');
  const score = typeof snap.value === 'number' ? snap.value : 0;
  const target = getEffectiveTarget(objective);
  const bands = targetBands(target);
  const composite = snap.shadow || {};
  const breakdown = Array.isArray(composite.breakdown) ? composite.breakdown : [];
  const competencies = breakdown
    .filter((b) => b.assessed)
    .sort((a, b) => (b.weight || 0) - (a.weight || 0))
    .map((b) => ({ name: b.competency, score: b.score, assessed: true }));
  const user = await User.findById(userId).select('firstName lastName profilePicture').lean();
  const ev = await module.exports._countEvidence(userId);
  return {
    displayName: [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() || 'A ScaleUp learner',
    avatarURL: user?.profilePicture || null,
    objectiveLabel: objective.specifics?.targetRole || objective.objectiveType || 'their goal',
    score, target, band: bandFor(score, bands),
    competencies,
    evidence: {
      assessments: ev.assessments,
      capstonesGraded: ev.capstonesGraded,
      coveragePct: typeof composite.coverage === 'number' ? Math.round(composite.coverage * 100) : null,
      hoursInvested: ev.hoursInvested,
    },
  };
}

const crypto = require('crypto');
const ReadinessProof = require('../../models/ReadinessProof');

const WEB_BASE = process.env.PUBLIC_WEB_BASE || 'https://scaleupapp.club';
function mintToken() { return crypto.randomBytes(12).toString('base64url'); } // ~16 chars, infeasible to guess

async function publish(userId) {
  const objective = await UserObjective.findOne({ userId, status: 'active', isPrimary: true }).lean();
  if (!objective) throw new Error('NO_OBJECTIVE');
  if (!objective.readyState?.isReady) throw new Error('NOT_READY');
  const snapshot = await module.exports.buildSnapshot(userId);
  const token = mintToken();
  await ReadinessProof.create({ token, userId, objectiveId: objective._id, active: true, issuedAt: new Date(), snapshot });
  const shareText = `I'm ${snapshot.objectiveLabel}-ready — verified by ScaleUp.`;
  return { token, url: `${WEB_BASE}/r/${token}`, shareText };
}

async function revoke(userId, token) {
  const q = { userId, active: true };
  if (token) q.token = token;
  await ReadinessProof.updateMany(q, { $set: { active: false } });
  return { ok: true };
}

async function getActive(userId) {
  const objective = await UserObjective.findOne({ userId, status: 'active', isPrimary: true }).select('_id').lean();
  if (!objective) return null;
  const p = await ReadinessProof.findOne({ userId, objectiveId: objective._id, active: true }).sort({ createdAt: -1 }).lean();
  return p ? { token: p.token, url: `${WEB_BASE}/r/${p.token}`, issuedAt: p.issuedAt } : null;
}

async function getPublic(token) {
  const p = await ReadinessProof.findOne({ token, active: true }).lean();
  if (!p) return null;
  ReadinessProof.updateOne({ _id: p._id }, { $inc: { viewCount: 1 } }).catch(() => {});
  return { issuedAt: p.issuedAt, ...p.snapshot };
}

module.exports = {
  buildSnapshot,
  bandFor,
  _countEvidence,
  publish,
  revoke,
  getActive,
  getPublic,
  mintToken,
};
