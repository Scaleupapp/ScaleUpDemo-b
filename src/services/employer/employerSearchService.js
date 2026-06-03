// src/services/employer/employerSearchService.js
'use strict';
const ranking = require('./talentRankingService');
const anonymizer = require('./talentAnonymizer');

function _escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Recruiter filters -> Mongo query. Always floored to the opted-in active pool.
function buildQuery(filters = {}) {
  const q = { optedIn: true, status: 'active' };
  if (Array.isArray(filters.bands) && filters.bands.length) q['snapshot.readinessBand'] = { $in: filters.bands };
  if (filters.objectiveType) q['snapshot.objectiveType'] = filters.objectiveType;
  if (filters.roleLabel) q['snapshot.roleLabel'] = new RegExp(_escapeRegex(filters.roleLabel), 'i');
  if (filters.targetCompany) q['snapshot.targetCompany'] = new RegExp(_escapeRegex(filters.targetCompany), 'i');
  if (Array.isArray(filters.skills) && filters.skills.length) q['snapshot.competencies.name'] = { $in: filters.skills };
  if (filters.city) q.city = new RegExp('^' + _escapeRegex(filters.city) + '$', 'i');
  if (filters.workPref && filters.workPref !== 'any') q.workPref = { $in: [filters.workPref, 'any', 'hybrid'] };
  if (filters.proof === 'verified') q['snapshot.verified'] = true;
  if (filters.proof === 'achieved') q['snapshot.achieved'] = true;
  return q;
}

module.exports = { buildQuery };
