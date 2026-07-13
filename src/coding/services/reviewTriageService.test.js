'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDossier,
  triagePending,
  closeOnResolution,
} = require('./reviewTriageService');

// ── Chainable query fakes ───────────────────────────────────────────────────
// Mongoose query builders (.find().select().sort().limit().lean()) are
// chained method calls that resolve to an array/doc only at the end (or when
// awaited directly). These tiny fakes support exactly the chain shapes this
// service uses, nothing more — repo convention: zero DB/network in tests.

function queryOf(result) {
  const q = {
    select: () => q,
    sort: () => q,
    limit: () => q,
    lean: async () => result,
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return q;
}

function makeHumanReviewQueue(items) {
  return {
    findById: (id) => queryOf(items.find((i) => String(i._id) === String(id)) || null),
    find: (filter = {}) => {
      const matched = items.filter((i) => (filter.status ? i.status === filter.status : true));
      return queryOf(matched);
    },
  };
}

function makeArtifactBundle(bundles) {
  return {
    findById: (id) => queryOf((id && bundles.find((b) => String(b._id) === String(id))) || null),
  };
}

function makeEvaluationAnchor(anchors) {
  return {
    find: (filter = {}) => queryOf(anchors.filter((a) => String(a.bundle_id) === String(filter.bundle_id))),
  };
}

function makeCapstoneSession(sessions) {
  return {
    find: (filter = {}) => queryOf(sessions.filter((s) =>
      String(s.bundle_id) === String(filter.bundle_id) && s.status === filter.status)),
  };
}

/**
 * AgentDecision fake: `rows` is a mutable array of plain objects. Documents
 * returned by findOne() get `.save()` / `.markModified()` so
 * closeOnResolution can mutate + persist exactly like a real Mongoose doc.
 */
function makeAgentDecision(rows) {
  // Decorates the row IN PLACE (same object reference as the `rows` array
  // element) rather than returning a copy — so mutations the service makes
  // directly on the "document" (row.status = ..., row.adjustmentDiff = ...)
  // are visible to the test via the original `decisionRows` array without
  // save() needing to reconcile two divergent copies.
  function asDoc(row) {
    if (!row) return null;
    if (!row.save) row.save = async function () { /* already in-place */ };
    if (!row.markModified) row.markModified = function () {};
    return row;
  }
  function matches(row, filter) {
    return Object.entries(filter).every(([k, v]) => {
      if (k === 'agentId') return row.agentId === v;
      if (k === 'status') return row.status === v;
      if (k === 'action.reviewItemId') return row.action && row.action.reviewItemId === v;
      return String(row[k]) === String(v);
    });
  }
  return {
    rows,
    findOne: (filter = {}) => {
      const found = rows.filter((r) => matches(r, filter));
      const q = {
        select: () => q,
        sort: () => ({ lean: async () => asDoc(found[0]) || null, then: (res) => Promise.resolve(asDoc(found[0]) || null).then(res) }),
        lean: async () => (found[0] || null),
        then: (resolve, reject) => Promise.resolve(asDoc(found[0]) || null).then(resolve, reject),
      };
      return q;
    },
    create: async (doc) => {
      const row = { _id: `dec_${rows.length + 1}`, status: 'pending', ...doc };
      rows.push(row);
      return row;
    },
  };
}

function baseDeps(overrides = {}) {
  const humanReviewItems = overrides.humanReviewItems || [];
  const bundles = overrides.bundles || [];
  const anchors = overrides.anchors || [];
  const sessions = overrides.sessions || [];
  const decisionRows = overrides.decisionRows || [];

  const AgentDecision = overrides.AgentDecision || makeAgentDecision(decisionRows);

  return {
    HumanReviewQueue: overrides.HumanReviewQueue || makeHumanReviewQueue(humanReviewItems),
    ArtifactBundle: overrides.ArtifactBundle || makeArtifactBundle(bundles),
    EvaluationAnchor: overrides.EvaluationAnchor || makeEvaluationAnchor(anchors),
    CapstoneSession: overrides.CapstoneSession || makeCapstoneSession(sessions),
    AgentDecision,
    isAgentEnabled: overrides.isAgentEnabled || (() => true),
    record: overrides.record || (async (payload) => AgentDecision.create(payload)),
    llmCall: overrides.llmCall || (async () => ({
      content: [{ type: 'text', text: JSON.stringify({ assessment: 'looks fine, tests pass', confidence: 0.8, recommendation: 'approve' }) }],
      usage: { input_tokens: 100, output_tokens: 50 },
      _meta: { taskId: 'review_triage_brief', provider: 'anthropic', model: 'claude-sonnet-4-6' },
    })),
    recordSpend: overrides.recordSpend || (async () => {}),
    now: overrides.now || (() => new Date('2026-07-13T00:00:00.000Z')),
  };
}

// ── buildDossier ─────────────────────────────────────────────────────────────

test('buildDossier: returns null when the review item does not exist', async () => {
  const deps = baseDeps({ humanReviewItems: [] });
  const dossier = await buildDossier({ reviewItemId: 'nope' }, deps);
  assert.strictEqual(dossier, null);
});

test('buildDossier: assembles null-safe evidence when the bundle/anchors/sessions are all missing', async () => {
  const deps = baseDeps({
    humanReviewItems: [{ _id: 'item1', reason: 'validator_failed', status: 'pending', bundle_id: null }],
  });
  const dossier = await buildDossier({ reviewItemId: 'item1' }, deps);
  assert.ok(dossier);
  assert.strictEqual(dossier.evidence.bundle, null);
  assert.strictEqual(dossier.evidence.anchorDrift.involvesDrift, false);
  assert.deepStrictEqual(dossier.evidence.anchorDrift.anchors, []);
  assert.strictEqual(dossier.evidence.sessions.count, 0);
  assert.strictEqual(dossier.evidence.sessions.avgScore, null);
  assert.strictEqual(dossier.recommendation.recommendation, 'approve');
});

test('buildDossier: assembles bundle, anchor-drift, and session evidence when present', async () => {
  const deps = baseDeps({
    humanReviewItems: [{ _id: 'item1', reason: 'capstone_anchor_drift session=s1', status: 'pending', bundle_id: 'b1' }],
    bundles: [{ _id: 'b1', type: 'capstone', role_track: 'swe', difficulty: 'hard', brief: 'Build a rate limiter' }],
    anchors: [{ bundle_id: 'b1', anchor_id: 'correctness', expected_score: 8, observed_scores: [{ score: 5, drift: 3 }, { score: 6, drift: 2 }] }],
    sessions: [
      { bundle_id: 'b1', status: 'graded', result: { overall_score: 80, integrity_confidence: 'high' }, counters: { paste_events: 2, tab_blur_events: 1 } },
      { bundle_id: 'b1', status: 'graded', result: { overall_score: 60, integrity_confidence: 'low' }, counters: { paste_events: 10, tab_blur_events: 5 } },
    ],
  });
  const dossier = await buildDossier({ reviewItemId: 'item1' }, deps);
  assert.strictEqual(dossier.evidence.bundle.role_track, 'swe');
  assert.strictEqual(dossier.evidence.anchorDrift.involvesDrift, true);
  assert.strictEqual(dossier.evidence.anchorDrift.anchors[0].observation_count, 2);
  assert.strictEqual(dossier.evidence.anchorDrift.anchors[0].mean_drift, 2.5);
  assert.strictEqual(dossier.evidence.sessions.count, 2);
  assert.strictEqual(dossier.evidence.sessions.avgScore, 70);
  assert.strictEqual(dossier.evidence.sessions.integrityConfidence.high, 1);
  assert.strictEqual(dossier.evidence.sessions.integrityConfidence.low, 1);
});

test('buildDossier: LLM call failure never throws — returns evidence with recommendation: null', async () => {
  let spendCalls = 0;
  const deps = baseDeps({
    humanReviewItems: [{ _id: 'item1', reason: 'validator_failed', status: 'pending', bundle_id: null }],
    llmCall: async () => { throw new Error('network down'); },
    recordSpend: async ({ outcome }) => { spendCalls += 1; assert.strictEqual(outcome, 'error'); },
  });
  const dossier = await buildDossier({ reviewItemId: 'item1' }, deps);
  assert.ok(dossier.evidence);
  assert.strictEqual(dossier.recommendation, null);
  assert.strictEqual(spendCalls, 1, 'spend must still be recorded on LLM failure so the sentinel sees the error row');
});

test('buildDossier: unparseable/invalid LLM JSON never throws — recommendation stays null but spend is still recorded', async () => {
  let spendCalls = 0;
  const deps = baseDeps({
    humanReviewItems: [{ _id: 'item1', reason: 'validator_failed', status: 'pending', bundle_id: null }],
    llmCall: async () => ({
      content: [{ type: 'text', text: 'not json at all' }],
      usage: { input_tokens: 10, output_tokens: 5 },
      _meta: { taskId: 'review_triage_brief', provider: 'anthropic', model: 'claude-sonnet-4-6' },
    }),
    recordSpend: async ({ outcome }) => { spendCalls += 1; assert.strictEqual(outcome, 'ok'); },
  });
  const dossier = await buildDossier({ reviewItemId: 'item1' }, deps);
  assert.strictEqual(dossier.recommendation, null);
  assert.strictEqual(spendCalls, 1);
});

// ── triagePending ────────────────────────────────────────────────────────────

test('triagePending: flag off short-circuits to zero DB reads', async () => {
  let touched = false;
  const deps = baseDeps({
    isAgentEnabled: () => false,
    HumanReviewQueue: { find: () => { touched = true; return queryOf([]); }, findById: () => queryOf(null) },
  });
  const result = await triagePending(deps);
  assert.deepStrictEqual(result, { triaged: 0 });
  assert.strictEqual(touched, false);
});

test('triagePending: dossiers every pending item and dedups items with an existing open dossier', async () => {
  const decisionRows = [
    { _id: 'existing', agentId: 'review_triage', status: 'pending', action: { reviewItemId: 'item1' } },
  ];
  const deps = baseDeps({
    humanReviewItems: [
      { _id: 'item1', reason: 'validator_failed', status: 'pending', bundle_id: null },
      { _id: 'item2', reason: 'validator_failed', status: 'pending', bundle_id: null },
    ],
    decisionRows,
  });
  const result = await triagePending(deps);
  assert.strictEqual(result.triaged, 1, 'item1 already has an open dossier — only item2 gets a new one');
  const newRows = deps.AgentDecision.rows.filter((r) => r.action.reviewItemId === 'item2');
  assert.strictEqual(newRows.length, 1);
  assert.strictEqual(newRows[0].agentId, 'review_triage');
  assert.strictEqual(newRows[0].decisionType, 'brief');
  assert.strictEqual(newRows[0].userId, undefined);
  assert.strictEqual(newRows[0].institutionId, undefined);
});

test('triagePending: one item failing (e.g. the ledger write itself) never blocks the rest of the sweep', async () => {
  const deps = baseDeps({
    humanReviewItems: [
      { _id: 'item1', reason: 'validator_failed', status: 'pending', bundle_id: null },
      { _id: 'item2', reason: 'validator_failed', status: 'pending', bundle_id: null },
    ],
  });
  let calls = 0;
  deps.record = async (payload) => {
    calls += 1;
    if (payload.action.reviewItemId === 'item1') throw new Error('ledger write failed');
    return deps.AgentDecision.create(payload);
  };
  const result = await triagePending(deps);
  assert.strictEqual(calls, 2, 'both items were attempted');
  assert.strictEqual(result.triaged, 1, 'item1 failed and is not counted; item2 still succeeded');
  assert.strictEqual(deps.AgentDecision.rows.some((r) => r.action.reviewItemId === 'item2'), true);
});

// ── closeOnResolution ────────────────────────────────────────────────────────

test('closeOnResolution: matching recommendation closes the row accepted', async () => {
  const decisionRows = [
    { _id: 'd1', agentId: 'review_triage', status: 'pending', createdAt: new Date('2026-07-01'), action: { reviewItemId: 'item1', recommendation: { recommendation: 'approve', confidence: 0.9, assessment: 'x' } } },
  ];
  const deps = baseDeps({ decisionRows });
  const result = await closeOnResolution({ reviewItemId: 'item1', resolution: 'approved' }, deps);
  assert.deepStrictEqual(result, { closed: true });
  assert.strictEqual(decisionRows[0].status, 'accepted');
  assert.ok(decisionRows[0].respondedAt);
});

test('closeOnResolution: mismatching recommendation closes the row adjusted with adjustmentDiff', async () => {
  const decisionRows = [
    { _id: 'd1', agentId: 'review_triage', status: 'pending', createdAt: new Date('2026-07-01'), action: { reviewItemId: 'item1', recommendation: { recommendation: 'approve', confidence: 0.9, assessment: 'x' } } },
  ];
  const deps = baseDeps({ decisionRows });
  const result = await closeOnResolution({ reviewItemId: 'item1', resolution: 'rejected' }, deps);
  assert.deepStrictEqual(result, { closed: true });
  assert.strictEqual(decisionRows[0].status, 'adjusted');
  assert.deepStrictEqual(decisionRows[0].adjustmentDiff, { humanResolution: 'rejected' });
});

test('closeOnResolution: evidence-only dossier (no recommendation) always accepts', async () => {
  const decisionRows = [
    { _id: 'd1', agentId: 'review_triage', status: 'pending', createdAt: new Date('2026-07-01'), action: { reviewItemId: 'item1', recommendation: null } },
  ];
  const deps = baseDeps({ decisionRows });
  const result = await closeOnResolution({ reviewItemId: 'item1', resolution: 'rejected' }, deps);
  assert.deepStrictEqual(result, { closed: true });
  assert.strictEqual(decisionRows[0].status, 'accepted');
});

test('closeOnResolution: no open dossier row is a no-op', async () => {
  const deps = baseDeps({ decisionRows: [] });
  const result = await closeOnResolution({ reviewItemId: 'item-does-not-exist', resolution: 'approved' }, deps);
  assert.deepStrictEqual(result, { closed: false });
});
