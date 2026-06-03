// src/services/employer/connectionService.js
'use strict';

async function _loadProfile(talentProfileId) {
  const TalentProfile = require('../../models/TalentProfile');
  return TalentProfile.findOne({ _id: talentProfileId, optedIn: true, status: 'active' }).lean();
}
async function _loadProfileForDisplay(id) {
  const TalentProfile = require('../../models/TalentProfile');
  return TalentProfile.findById(id).lean();
}
async function _upsertConnection(key, patch) {
  const ConnectionRequest = require('../../models/ConnectionRequest');
  return ConnectionRequest.findOneAndUpdate(key, patch, { upsert: true, new: true, setDefaultsOnInsert: true });
}

// Contact-tier employer expresses interest. Idempotent per (employer, candidate, objective).
// The candidate profile must still be in the pool (opted-in + active).
async function expressInterest(employerId, talentProfileId, { message, roleContext } = {}) {
  const profile = await module.exports._loadProfile(talentProfileId);
  // _loadProfile is already pool-filtered; the extra optedIn/status check is defence-in-depth
  // (and makes the guard meaningful when tests stub _loadProfile to bypass the DB filter).
  if (!profile || !profile.optedIn || profile.status !== 'active') throw new Error('PROFILE_UNAVAILABLE');
  const key = { employerId, candidateUserId: profile.userId, objectiveId: profile.objectiveId };
  const patch = { $setOnInsert: { talentProfileId: profile._id, message: message || '', roleContext: roleContext || '', status: 'requested' } };
  return module.exports._upsertConnection(key, patch);
}

module.exports = { expressInterest, _loadProfile, _loadProfileForDisplay, _upsertConnection };

const views = require('./connectionViewService');

async function _loadConnectionById(id) {
  const ConnectionRequest = require('../../models/ConnectionRequest');
  return ConnectionRequest.findById(id);
}
async function _findForCandidate(candidateUserId) {
  const ConnectionRequest = require('../../models/ConnectionRequest');
  return ConnectionRequest.find({ candidateUserId }).sort({ createdAt: -1 }).lean();
}
async function _findForEmployer(employerId) {
  const ConnectionRequest = require('../../models/ConnectionRequest');
  return ConnectionRequest.find({ employerId }).sort({ createdAt: -1 }).lean();
}
async function _loadEmployer(id) {
  const EmployerAccount = require('../../models/EmployerAccount');
  return EmployerAccount.findById(id).select('companyName name email').lean();
}
async function _loadCandidate(id) {
  const User = require('../../models/User');
  return User.findById(id).select('firstName lastName email phone').lean();
}

// Candidate approves/declines an incoming request they own.
async function respond(connectionId, candidateUserId, decision) {
  if (decision !== 'approved' && decision !== 'declined') throw new Error('BAD_DECISION');
  const conn = await module.exports._loadConnectionById(connectionId);
  // Wrong owner returns NOT_FOUND (not 403) on purpose — don't confirm a connection exists to a non-owner.
  if (!conn || String(conn.candidateUserId) !== String(candidateUserId)) throw new Error('NOT_FOUND');
  if (conn.status !== 'requested') throw new Error('ALREADY_RESPONDED');
  conn.status = decision;
  conn.respondedAt = new Date();
  await conn.save();
  if (decision === 'approved') {
    console.info(`[audit] connection.approved connectionId=${conn._id} employerId=${conn.employerId} candidateUserId=${conn.candidateUserId} at=${conn.respondedAt.toISOString()}`);
  }
  return conn;
}

// Candidate inbox — employer masked unless approved.
async function listForCandidate(candidateUserId) {
  const rows = await module.exports._findForCandidate(candidateUserId);
  return Promise.all(rows.map(async (c) => {
    const employer = c.status === 'approved' ? await module.exports._loadEmployer(c.employerId) : null;
    return views.candidateView(c, employer);
  }));
}

// Employer's sent list — candidate revealed only on approval.
async function listForEmployer(employerId) {
  const rows = await module.exports._findForEmployer(employerId);
  return Promise.all(rows.map(async (c) => {
    const profile = await module.exports._loadProfileForDisplay(c.talentProfileId);
    const candidate = c.status === 'approved' ? await module.exports._loadCandidate(c.candidateUserId) : null;
    return views.employerView(c, profile, candidate);
  }));
}

module.exports.respond = respond;
module.exports.listForCandidate = listForCandidate;
module.exports.listForEmployer = listForEmployer;
module.exports._loadConnectionById = _loadConnectionById;
module.exports._findForCandidate = _findForCandidate;
module.exports._findForEmployer = _findForEmployer;
module.exports._loadEmployer = _loadEmployer;
module.exports._loadCandidate = _loadCandidate;
