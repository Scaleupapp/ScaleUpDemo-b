'use strict';
const FIELDS = ['studentName','rollNumber','branch','companyName','role','ctc','offerType','status','offerDate','driveId','notes'];
function pick(b = {}) { const o = {}; for (const k of FIELDS) if (b[k] !== undefined) o[k] = b[k]; return o; }
function median(nums) { if (!nums.length) return null; const s = [...nums].sort((a,b)=>a-b); const m = Math.floor(s.length/2); return s.length % 2 ? s[m] : Math.round((s[m-1]+s[m])/2); }
function studentKey(o) { return o.rollNumber ? `r:${o.rollNumber}` : `n:${o.studentName}`; }
function summarize(offers, cohortSize) {
  const placedOffers = offers.filter((o) => o.status === 'accepted' || o.status === 'joined');
  const placedKeys = new Set(placedOffers.map(studentKey));
  const placedCount = placedKeys.size;
  const placementPercent = cohortSize > 0 ? Math.round((placedCount / cohortSize) * 100) : 0;
  const ctcs = placedOffers.map((o) => o.ctc).filter((c) => typeof c === 'number');
  const highestCtc = ctcs.length ? Math.max(...ctcs) : null;
  const averageCtc = ctcs.length ? Math.round(ctcs.reduce((a,b)=>a+b,0) / ctcs.length) : null;
  const medianCtc = median(ctcs);
  const companiesVisited = new Set(offers.map((o) => (o.companyName||'').trim().toLowerCase()).filter(Boolean)).size;
  const statusCounts = { offered: 0, accepted: 0, joined: 0, declined: 0 };
  for (const o of offers) if (statusCounts[o.status] !== undefined) statusCounts[o.status]++;
  // count distinct placed students per branch
  const seenByBranch = {};
  for (const o of placedOffers) { const b = o.branch && o.branch.trim(); if (!b) continue; (seenByBranch[b] ||= new Set()).add(studentKey(o)); }
  const branchWise = Object.keys(seenByBranch).map((b) => ({ branch: b, placed: seenByBranch[b].size })).sort((a,b)=>b.placed-a.placed);
  return { cohortSize, placedCount, placementPercent, highestCtc, averageCtc, medianCtc, companiesVisited, statusCounts, branchWise };
}
function models(deps) {
  return {
    Offer: (deps && deps.PlacementOffer) || require('../../models/PlacementOffer'),
    Enrollment: (deps && deps.InstitutionEnrollment) || require('../../models/InstitutionEnrollment'),
    Cohort: (deps && deps.InstitutionCohort) || require('../../models/InstitutionCohort'),
  };
}
async function createOffer(scope, cohortId, body, deps) { const { Offer } = models(deps); return Offer.create({ ...scope, cohortId, ...pick(body) }); }
async function listOffers(scope, cohortId, deps) { const { Offer } = models(deps); const q = Offer.find({ ...scope, cohortId }).sort({ createdAt: -1 }).limit(2000); return typeof q.lean === 'function' ? q.lean() : q; }
async function updateOffer(scope, cohortId, offerId, body, deps) { const { Offer } = models(deps); const o = await Offer.findOneAndUpdate({ ...scope, cohortId, _id: offerId }, { $set: pick(body) }, { new: true }); if (!o) throw new Error('OFFER_NOT_FOUND'); return o; }
async function deleteOffer(scope, cohortId, offerId, deps) { const { Offer } = models(deps); const o = await Offer.findOneAndDelete({ ...scope, cohortId, _id: offerId }); if (!o) throw new Error('OFFER_NOT_FOUND'); return o; }
async function importOffers(scope, cohortId, rows, deps) { const { Offer } = models(deps); const docs = (rows||[]).filter((r)=>r && r.studentName && r.companyName).map((r)=>({ ...scope, cohortId, ...pick(r) })); if (!docs.length) return { created: 0 }; const res = await Offer.insertMany(docs); return { created: res.length }; }
async function cohortOutcomes(scope, cohortId, deps) {
  const { Offer, Enrollment } = models(deps);
  const oq = Offer.find({ ...scope, cohortId }); const offers = typeof oq.lean === 'function' ? await oq.lean() : await oq;
  const cohortSize = await Enrollment.countDocuments({ ...scope, cohortId });
  return summarize(offers, cohortSize);
}
async function institutionOutcomes(scope, deps) {
  const { Offer, Enrollment, Cohort } = models(deps);
  const cq = Cohort.find({ ...scope }); const cohorts = typeof cq.lean === 'function' ? await cq.lean() : await cq;
  const oq = Offer.find({ ...scope }); const allOffers = typeof oq.lean === 'function' ? await oq.lean() : await oq;
  const totalEnroll = await Enrollment.countDocuments({ ...scope });
  const perCohort = [];
  for (const c of cohorts) {
    const offers = allOffers.filter((o) => String(o.cohortId) === String(c._id));
    const size = await Enrollment.countDocuments({ ...scope, cohortId: c._id });
    perCohort.push({ cohortId: String(c._id), label: c.label, summary: summarize(offers, size) });
  }
  return { cohorts: perCohort, institution: summarize(allOffers, totalEnroll) };
}
module.exports = { summarize, createOffer, listOffers, updateOffer, deleteOffer, importOffers, cohortOutcomes, institutionOutcomes };
