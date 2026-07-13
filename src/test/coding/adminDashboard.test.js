'use strict';

/**
 * Unit tests for src/coding/controllers/adminDashboard.controller.js
 *
 * Covers Plan 6 Task 2 (triage wiring):
 *   - GET /human-review: each item gains an additive `dossier` key sourced
 *     from the latest `review_triage` AgentDecision row for that item.
 *   - POST /human-review/:id/resolve: the reviewer's real approve/reject
 *     decision persists first, then fires closeOnResolution fire-and-forget.
 *
 * No DI seam exists on this controller (module-level `require`s, matching
 * every other coding controller) — so, per repo convention (see
 * src/test/openapi-contract.test.js's PlanCurrent/PlanStatus tests), the
 * model/service modules this controller imports are stubbed via
 * require.cache BEFORE the controller is required, then the SAME stub
 * object is mutated per test (the controller's `const X = require(...)`
 * binding is fixed to that object reference at require time).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const HRQ_PATH = require.resolve('../../coding/models/humanReviewQueue.model');
const AGENT_DECISION_PATH = require.resolve('../../models/AgentDecision');
const TRIAGE_SVC_PATH = require.resolve('../../coding/services/reviewTriageService');
const CTRL_PATH = require.resolve('../../coding/controllers/adminDashboard.controller');

// ── Chainable query fake (find().populate().sort().limit().select().lean()) ──
function queryOf(result) {
  const q = {
    populate: () => q,
    sort: () => q,
    limit: () => q,
    select: () => q,
    lean: async () => result,
  };
  return q;
}

function fakeDoc(data) {
  const doc = { ...data };
  doc.save = async function () { /* mutations already applied in place */ };
  doc.toObject = function () {
    const { save, toObject, ...rest } = doc;
    return rest;
  };
  return doc;
}

function fakeRes() {
  const r = { _status: 200, _json: null };
  r.status = (s) => { r._status = s; return r; };
  r.json = (j) => { r._json = j; return r; };
  return r;
}

// Fake objects installed into require.cache — mutated per test, same
// reference the controller captured at require time.
const fakeHRQ = { find: () => queryOf([]), findById: () => Promise.resolve(null) };
const fakeAgentDecision = { find: () => queryOf([]) };
const fakeTriageService = { closeOnResolution: async () => ({ closed: false }) };

let ctrl;

test.before(() => {
  require.cache[HRQ_PATH] = { exports: fakeHRQ, loaded: true, id: HRQ_PATH };
  require.cache[AGENT_DECISION_PATH] = { exports: fakeAgentDecision, loaded: true, id: AGENT_DECISION_PATH };
  require.cache[TRIAGE_SVC_PATH] = { exports: fakeTriageService, loaded: true, id: TRIAGE_SVC_PATH };
  delete require.cache[CTRL_PATH];
  ctrl = require(CTRL_PATH);
});

test.after(() => {
  delete require.cache[HRQ_PATH];
  delete require.cache[AGENT_DECISION_PATH];
  delete require.cache[TRIAGE_SVC_PATH];
  delete require.cache[CTRL_PATH];
});

// ── GET /human-review ────────────────────────────────────────────────────────

test('humanReview: list item gains a dossier from the latest review_triage AgentDecision row', async () => {
  fakeHRQ.find = () => queryOf([{ _id: 'item1', reason: 'validator_failed', status: 'pending' }]);
  fakeAgentDecision.find = () => queryOf([
    {
      action: {
        reviewItemId: 'item1',
        evidence: { reviewItem: { reason: 'validator_failed' } },
        recommendation: { recommendation: 'approve', confidence: 0.8, assessment: 'looks fine' },
      },
      createdAt: new Date('2026-07-10T00:00:00.000Z'),
      status: 'pending',
    },
  ]);

  const req = { query: {} };
  const res = fakeRes();
  await ctrl.humanReview(req, res);

  assert.strictEqual(res._status, 200);
  assert.strictEqual(res._json.items.length, 1);
  const dossier = res._json.items[0].dossier;
  assert.ok(dossier, 'dossier must be present');
  assert.strictEqual(dossier.recommendation.recommendation, 'approve');
  assert.deepStrictEqual(dossier.evidence, { reviewItem: { reason: 'validator_failed' } });
  assert.strictEqual(dossier.status, 'pending');
  // Additive-only: the item's own fields survive untouched.
  assert.strictEqual(res._json.items[0].reason, 'validator_failed');
});

test('humanReview: dossier is null when no AgentDecision row exists for the item', async () => {
  fakeHRQ.find = () => queryOf([{ _id: 'item2', reason: 'capstone_anchor_drift session=s1', status: 'pending' }]);
  fakeAgentDecision.find = () => queryOf([]); // no dossiers at all (e.g. flag off / not swept yet)

  const req = { query: {} };
  const res = fakeRes();
  await ctrl.humanReview(req, res);

  assert.strictEqual(res._json.items.length, 1);
  assert.strictEqual(res._json.items[0].dossier, null);
});

// ── POST /human-review/:id/resolve ──────────────────────────────────────────

test('resolveHumanReview: persists the resolution then fires closeOnResolution fire-and-forget', async () => {
  const item = fakeDoc({ _id: 'item3', status: 'pending', bundle_id: 'b1' });
  fakeHRQ.findById = (id) => { assert.strictEqual(id, 'item3'); return Promise.resolve(item); };

  let hookCall = null;
  fakeTriageService.closeOnResolution = async (args) => { hookCall = args; return { closed: true }; };

  const req = { params: { id: 'item3' }, body: { resolution: 'approved' }, user: { userId: 'admin1' } };
  const res = fakeRes();
  await ctrl.resolveHumanReview(req, res);

  assert.strictEqual(res._status, 200);
  assert.strictEqual(item.status, 'approved');
  assert.strictEqual(item.reviewer_id, 'admin1');
  assert.ok(item.reviewed_at instanceof Date);
  assert.strictEqual(res._json.item.status, 'approved');
  // The hook was invoked synchronously (its own promise need not resolve
  // before the response is sent — fire-and-forget, never in the critical path).
  assert.deepStrictEqual(hookCall, { reviewItemId: 'item3', resolution: 'approved' });
});

test('resolveHumanReview: flag-off interplay — resolving an item with no open dossier still succeeds (closeOnResolution no-ops)', async () => {
  const item = fakeDoc({ _id: 'item4', status: 'pending' });
  fakeHRQ.findById = () => Promise.resolve(item);
  // Simulates review_triage flag off / never swept: closeOnResolution finds
  // no dossier row and no-ops rather than throwing.
  fakeTriageService.closeOnResolution = async () => ({ closed: false });

  const req = { params: { id: 'item4' }, body: { resolution: 'rejected' }, user: { userId: 'admin1' } };
  const res = fakeRes();
  await ctrl.resolveHumanReview(req, res);

  assert.strictEqual(res._status, 200);
  assert.strictEqual(item.status, 'rejected');

  // Invalid resolution is rejected before any state mutation or hook call.
  const badReq = { params: { id: 'item4' }, body: { resolution: 'maybe' }, user: { userId: 'admin1' } };
  const badRes = fakeRes();
  let hookCalledForBadReq = false;
  fakeTriageService.closeOnResolution = async () => { hookCalledForBadReq = true; return { closed: false }; };
  await ctrl.resolveHumanReview(badReq, badRes);
  assert.strictEqual(badRes._status, 400);
  assert.strictEqual(hookCalledForBadReq, false);
});
