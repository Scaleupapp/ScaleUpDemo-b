'use strict';

const { test } = require('node:test');
const assert = require('assert');
const mongoose = require('mongoose');

const { makeHandlers } = require('./agentDecisions');

function res() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

test('respond handler: happy path returns applied status', async () => {
  const decisionId = new mongoose.Types.ObjectId();
  const h = makeHandlers({
    isAgentEnabled: () => true,
    respond: async ({ decisionId: id, userId, response }) => {
      assert.strictEqual(String(id), String(decisionId));
      assert.strictEqual(userId, 'u1');
      assert.strictEqual(response, 'accepted');
      return { decision: { _id: decisionId, status: 'accepted' }, applied: true };
    },
  });
  const r = res();
  await h.respondHandler({ user: { userId: 'u1' }, params: { id: String(decisionId) }, body: { response: 'accepted' } }, r);
  assert.strictEqual(r.statusCode, 200);
  assert.deepStrictEqual(r.body, { success: true, data: { decisionId: String(decisionId), status: 'accepted', applied: true } });
});

test('respond handler: flag off → 404 envelope (house convention)', async () => {
  const h = makeHandlers({ isAgentEnabled: () => false, respond: async () => { throw new Error('should not run'); } });
  const r = res();
  await h.respondHandler({ user: { userId: 'u1' }, params: { id: 'x' }, body: { response: 'accepted' } }, r);
  assert.strictEqual(r.statusCode, 404);
  assert.strictEqual(r.body.success, false);
});

test('respond handler: service "not found" → 404, "already" → 409', async () => {
  const h404 = makeHandlers({ isAgentEnabled: () => true, respond: async () => { throw new Error('decision not found'); } });
  const r1 = res();
  await h404.respondHandler({ user: { userId: 'u1' }, params: { id: 'x' }, body: { response: 'accepted' } }, r1);
  assert.strictEqual(r1.statusCode, 404);

  const h409 = makeHandlers({ isAgentEnabled: () => true, respond: async () => { throw new Error('decision already accepted'); } });
  const r2 = res();
  await h409.respondHandler({ user: { userId: 'u1' }, params: { id: 'x' }, body: { response: 'accepted' } }, r2);
  assert.strictEqual(r2.statusCode, 409);
});

test('list handler: returns caller-scoped pending decisions', async () => {
  const rows = [{ _id: 'd1', action: { title: 'T' }, status: 'pending', createdAt: new Date() }];
  const h = makeHandlers({
    isAgentEnabled: () => true,
    listForUser: async (userId, status) => {
      assert.strictEqual(userId, 'u1');
      assert.strictEqual(status, 'pending');
      return rows;
    },
  });
  const r = res();
  await h.listHandler({ user: { userId: 'u1' }, query: { status: 'pending' } }, r);
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.body.data.decisions.length, 1);
});

test('list handler: default listForUser projects out internal telemetry fields', async () => {
  // Mirrors recommendationService.test.js's monkey-patch-the-static-method
  // convention for exercising a route's default (non-injected) query path.
  const AgentDecision = require('../../models/AgentDecision');
  const originalFind = AgentDecision.find;
  const selectCalls = [];
  const rows = [{ _id: 'd1', agentId: 'compass_actions', status: 'pending', action: { title: 'T' }, createdAt: new Date() }];

  AgentDecision.find = (filter) => ({
    select: (projection) => {
      selectCalls.push(projection);
      return {
        sort: () => ({
          limit: () => ({
            lean: async () => rows,
          }),
        }),
      };
    },
  });

  try {
    const h = makeHandlers({ isAgentEnabled: () => true }); // no listForUser override -> exercises defaultListForUser
    const r = res();
    await h.listHandler({ user: { userId: 'u1' }, query: { status: 'pending' } }, r);

    assert.strictEqual(r.statusCode, 200);
    assert.deepStrictEqual(r.body.data.decisions, rows);
    assert.strictEqual(selectCalls.length, 1);
    const projection = selectCalls[0];
    assert.strictEqual(typeof projection, 'string');
    // Internal telemetry must never be requested from the DB for this list.
    assert.ok(!projection.includes('costUsd'), 'costUsd must not be in the projection');
    assert.ok(!projection.includes('modelId'), 'modelId must not be in the projection');
    assert.ok(!projection.includes('promptVersion'), 'promptVersion must not be in the projection');
    assert.ok(!projection.includes('contextSnapshot'), 'contextSnapshot must not be in the projection');
    assert.ok(!projection.includes('toolTrace'), 'toolTrace must not be in the projection');
    // Sanity: the client-facing fields ARE requested.
    assert.ok(projection.includes('status'));
    assert.ok(projection.includes('action'));
  } finally {
    AgentDecision.find = originalFind;
  }
});
