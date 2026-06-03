// src/services/employer/connectionService.js
'use strict';

async function _loadProfile(talentProfileId) {
  const TalentProfile = require('../../models/TalentProfile');
  return TalentProfile.findOne({ _id: talentProfileId, optedIn: true, status: 'active' }).lean();
}
async function _upsertConnection(key, patch) {
  const ConnectionRequest = require('../../models/ConnectionRequest');
  return ConnectionRequest.findOneAndUpdate(key, patch, { upsert: true, new: true, setDefaultsOnInsert: true });
}

// Contact-tier employer expresses interest. Idempotent per (employer, candidate, objective).
// The candidate profile must still be in the pool (opted-in + active).
async function expressInterest(employerId, talentProfileId, { message, roleContext } = {}) {
  const profile = await module.exports._loadProfile(talentProfileId);
  if (!profile || !profile.optedIn || profile.status !== 'active') throw new Error('PROFILE_UNAVAILABLE');
  const key = { employerId, candidateUserId: profile.userId, objectiveId: profile.objectiveId };
  const patch = { $setOnInsert: { talentProfileId: profile._id, message: message || '', roleContext: roleContext || '', status: 'requested' } };
  return module.exports._upsertConnection(key, patch);
}

module.exports = { expressInterest, _loadProfile, _upsertConnection };
