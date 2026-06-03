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
  if (filters.workPref && filters.workPref !== 'any') q.workPref = { $in: [...new Set([filters.workPref, 'any', 'hybrid'])] };
  if (filters.proof === 'verified') q['snapshot.verified'] = true;
  if (filters.proof === 'achieved') q['snapshot.achieved'] = true;
  return q;
}

module.exports = { buildQuery };

const DEFAULT_LIMIT = 25;

// Best-effort marketplace hooks: audit/analytics must NEVER break search/getCandidate.
function _event(evt, props) { try { require('../diagnosticTelemetryService').logEvent(evt, props); } catch (_) {} }
function _hook(fn) { Promise.resolve().then(fn).catch(() => {}); }

async function _find(query) {
  const TalentProfile = require('../../models/TalentProfile');
  return TalentProfile.find(query).lean();
}
async function _findOne(id) {
  const TalentProfile = require('../../models/TalentProfile');
  return TalentProfile.findOne({ _id: id, optedIn: true, status: 'active' }).lean();
}

// Filter -> query -> rank -> anonymized browse cards (paged).
async function search(filters = {}, opts = {}) {
  const limit = Math.max(1, Math.min(100, opts.limit || DEFAULT_LIMIT));
  const rows = await module.exports._find(buildQuery(filters));
  const ranked = ranking.rank(rows);
  _event('marketplace.search', { employerId: opts.employerId ? String(opts.employerId) : null, total: ranked.length });
  return { total: ranked.length, results: ranked.slice(0, limit).map(anonymizer.toBrowseCard) };
}

// One candidate's anonymized profile (only if still in the pool).
async function getCandidate(id, ctx = {}) {
  const row = await module.exports._findOne(id);
  if (!row) return null;
  // Best-effort: durable view audit + analytics (only when we know the viewing employer).
  if (ctx.employerId) {
    _hook(() => require('./marketplaceAuditService').logView({ employerId: ctx.employerId, talentProfileId: id }));
    _event('marketplace.candidate_view', { employerId: String(ctx.employerId), talentProfileId: String(id) });
  }
  return anonymizer.toAnonymizedProfile(row);
}

module.exports.search = search;
module.exports.getCandidate = getCandidate;
module.exports._find = _find;
module.exports._findOne = _findOne;
