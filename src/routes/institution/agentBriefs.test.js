'use strict';

const { test } = require('node:test');
const assert = require('assert');
const mongoose = require('mongoose');

const { makeHandlers } = require('./agentBriefs');

function res() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

function baseReq(overrides = {}) {
  return {
    institution: { institutionId: 'inst1', institutionUserId: 'iu1', role: 'tpo_head' },
    params: {},
    query: {},
    body: {},
    ...overrides,
  };
}

function makeFindChain(rows) {
  return {
    sort: () => ({
      limit: async () => rows,
    }),
  };
}

// ── GET /agent/briefs ───────────────────────────────────────────────────

test('GET agent/briefs: happy path shapes decisions for the UI', async () => {
  const decisionId = new mongoose.Types.ObjectId();
  const cohortId = new mongoose.Types.ObjectId();
  const row = {
    _id: decisionId,
    cohortId,
    status: 'pending',
    createdAt: new Date('2026-07-06T00:00:00Z'),
    action: {
      cohortLabel: 'Cohort A',
      clusters: [
        {
          key: 'not_started',
          label: 'Not started',
          studentIds: ['s1', 's2'],
          evidence: { notStartedCount: 2 },
          proposedAction: { kind: 'notify_students', payload: { title: 'Start now', message: 'Go' } },
        },
      ],
    },
  };
  const h = makeHandlers({
    isAgentEnabled: () => true,
    AgentDecision: {
      find: (query) => {
        assert.strictEqual(query.agentId, 'intervention');
        assert.strictEqual(query.institutionId, 'inst1');
        return makeFindChain([row]);
      },
    },
  });
  const r = res();
  await h.listBriefsHandler(baseReq(), r);

  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.body.success, true);
  assert.strictEqual(r.body.data.decisions.length, 1);
  const brief = r.body.data.decisions[0];
  assert.strictEqual(brief.id, String(decisionId));
  assert.strictEqual(brief.cohortId, String(cohortId));
  assert.strictEqual(brief.cohortLabel, 'Cohort A');
  assert.strictEqual(brief.status, 'pending');
  assert.deepStrictEqual(brief.clusters, [
    {
      key: 'not_started',
      label: 'Not started',
      count: 2,
      evidence: { notStartedCount: 2 },
      proposedAction: { kind: 'notify_students', payload: { title: 'Start now', message: 'Go' } },
    },
  ]);
});

test('GET agent/briefs: intervention flag off -> 404 envelope', async () => {
  const h = makeHandlers({
    isAgentEnabled: () => false,
    AgentDecision: { find: () => { throw new Error('should not query'); } },
  });
  const r = res();
  await h.listBriefsHandler(baseReq(), r);
  assert.strictEqual(r.statusCode, 404);
  assert.strictEqual(r.body.success, false);
});

// ── POST /agent/briefs/:decisionId/approve ─────────────────────────────

test('POST agent/briefs/:id/approve: happy path delegates to briefApprovalService', async () => {
  const h = makeHandlers({
    isAgentEnabled: () => true,
    approveBrief: async ({ decisionId, institutionId, actorInstitutionUserId, clusterKeys }) => {
      assert.strictEqual(decisionId, 'dec1');
      assert.strictEqual(institutionId, 'inst1');
      assert.strictEqual(actorInstitutionUserId, 'iu1');
      assert.deepStrictEqual(clusterKeys, ['not_started']);
      return { executed: { notified: 2 }, status: 'adjusted' };
    },
  });
  const r = res();
  await h.approveBriefHandler(
    baseReq({ params: { decisionId: 'dec1' }, body: { clusterKeys: ['not_started'] } }),
    r
  );
  assert.strictEqual(r.statusCode, 200);
  assert.deepStrictEqual(r.body, { success: true, data: { executed: { notified: 2 }, status: 'adjusted' } });
});

test('POST agent/briefs/:id/approve: missing clusterKeys -> 400', async () => {
  const h = makeHandlers({
    isAgentEnabled: () => true,
    approveBrief: async () => { throw new Error('should not run'); },
  });
  const r = res();
  await h.approveBriefHandler(baseReq({ params: { decisionId: 'dec1' }, body: {} }), r);
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(r.body.success, false);
});

test('POST agent/briefs/:id/approve: empty clusterKeys array -> 400', async () => {
  const h = makeHandlers({
    isAgentEnabled: () => true,
    approveBrief: async () => { throw new Error('should not run'); },
  });
  const r = res();
  await h.approveBriefHandler(baseReq({ params: { decisionId: 'dec1' }, body: { clusterKeys: [] } }), r);
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(r.body.success, false);
});

test('POST agent/briefs/:id/approve: error mapping (not found/already/unsupported/else)', async () => {
  const cases = [
    { err: 'brief not found', status: 404 },
    { err: 'brief already accepted', status: 409 },
    { err: 'unsupported cluster key: bogus', status: 400 },
    { err: 'boom', status: 500 },
  ];
  for (const c of cases) {
    const h = makeHandlers({
      isAgentEnabled: () => true,
      approveBrief: async () => { throw new Error(c.err); },
    });
    const r = res();
    await h.approveBriefHandler(baseReq({ params: { decisionId: 'dec1' }, body: { clusterKeys: ['x'] } }), r);
    assert.strictEqual(r.statusCode, c.status, `expected ${c.status} for "${c.err}"`);
    assert.strictEqual(r.body.success, false);
  }
});

// ── GET /agent/activation ───────────────────────────────────────────────

test('GET agent/activation: happy path returns getFunnel result', async () => {
  const h = makeHandlers({
    isAgentEnabled: () => true,
    getFunnel: async ({ institutionId, cohortId }) => {
      assert.strictEqual(institutionId, 'inst1');
      assert.strictEqual(cohortId, 'c1');
      return { invited: 5, claimed: 3, claimRate: 0.375, exhausted: 1, lastBatch: null };
    },
  });
  const r = res();
  await h.getActivationHandler(baseReq({ query: { cohortId: 'c1' } }), r);
  assert.strictEqual(r.statusCode, 200);
  assert.deepStrictEqual(r.body.data, { invited: 5, claimed: 3, claimRate: 0.375, exhausted: 1, lastBatch: null });
});

test('GET agent/activation: missing cohortId -> 400', async () => {
  const h = makeHandlers({
    isAgentEnabled: () => true,
    getFunnel: async () => { throw new Error('should not run'); },
  });
  const r = res();
  await h.getActivationHandler(baseReq({ query: {} }), r);
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(r.body.success, false);
});

test('GET agent/activation: activation flag off -> 404 envelope', async () => {
  const h = makeHandlers({
    isAgentEnabled: () => false,
    getFunnel: async () => { throw new Error('should not run'); },
  });
  const r = res();
  await h.getActivationHandler(baseReq({ query: { cohortId: 'c1' } }), r);
  assert.strictEqual(r.statusCode, 404);
  assert.strictEqual(r.body.success, false);
});
