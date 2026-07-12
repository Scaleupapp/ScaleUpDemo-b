// src/services/agentDecisionService.test.js
'use strict';

const { test } = require('node:test');
const assert = require('assert');
const mongoose = require('mongoose');

const svc = require('./agentDecisionService');

// ---- fakes (no DB) ----------------------------------------------------
function fakePlanModel(calls) {
  return {
    updateOne: async (filter, update, opts) => {
      calls.push({ filter, update, opts });
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
}

function fakeDecisionDoc(overrides = {}) {
  return Object.assign(
    {
      _id: new mongoose.Types.ObjectId(),
      userId: new mongoose.Types.ObjectId(),
      status: 'pending',
      action: { title: 'x', ops: [{ op: 'reset_skipped' }] },
      save: async function () { return this; },
    },
    overrides
  );
}

function fakeDecisionModel(doc) {
  return {
    findById: async () => doc,
    updateMany: async (filter, update) => {
      fakeDecisionModel.lastSweep = { filter, update };
      return { modifiedCount: 3 };
    },
    create: async (payload) => Object.assign({ _id: new mongoose.Types.ObjectId() }, payload),
  };
}

// ---- applyPlanOps ------------------------------------------------------
test('applyPlanOps: set_task_status issues the scoped task mutation', async () => {
  const calls = [];
  const r = await svc.applyPlanOps('u1', [{ op: 'set_task_status', taskId: 't9', status: 'skipped' }], { Plan: fakePlanModel(calls) });
  assert.strictEqual(r.applied, 1);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].filter, { userId: 'u1', isActive: true });
  assert.strictEqual(calls[0].update.$set['weeklySchedule.$[].tasks.$[t].progress.status'], 'skipped');
  assert.deepStrictEqual(calls[0].opts.arrayFilters, [{ 't.taskId': 't9' }]);
});

test('applyPlanOps: reset_skipped flips all skipped back to pending', async () => {
  const calls = [];
  await svc.applyPlanOps('u1', [{ op: 'reset_skipped' }], { Plan: fakePlanModel(calls) });
  assert.strictEqual(calls[0].update.$set['weeklySchedule.$[].tasks.$[t].progress.status'], 'pending');
  assert.deepStrictEqual(calls[0].opts.arrayFilters, [{ 't.progress.status': 'skipped' }]);
});

test('applyPlanOps: unknown ops are rejected, nothing applied', async () => {
  const calls = [];
  await assert.rejects(
    () => svc.applyPlanOps('u1', [{ op: 'delete_everything' }], { Plan: fakePlanModel(calls) }),
    /unsupported op/
  );
  assert.strictEqual(calls.length, 0);
});

test('applyPlanOps: set_task_status requires a valid status', async () => {
  await assert.rejects(
    () => svc.applyPlanOps('u1', [{ op: 'set_task_status', taskId: 't1', status: 'exploded' }], { Plan: fakePlanModel([]) }),
    /unsupported status/
  );
});

// ---- respond -----------------------------------------------------------
test('respond: accepted applies ops and stamps the signal', async () => {
  const doc = fakeDecisionDoc();
  const calls = [];
  const r = await svc.respond(
    { decisionId: doc._id, userId: String(doc.userId), response: 'accepted' },
    { AgentDecision: fakeDecisionModel(doc), Plan: fakePlanModel(calls) }
  );
  assert.strictEqual(r.applied, true);
  assert.strictEqual(doc.status, 'accepted');
  assert.ok(doc.respondedAt instanceof Date);
  assert.strictEqual(calls.length, 1);
});

test('respond: rejected records signal, applies nothing', async () => {
  const doc = fakeDecisionDoc();
  const calls = [];
  const r = await svc.respond(
    { decisionId: doc._id, userId: String(doc.userId), response: 'rejected' },
    { AgentDecision: fakeDecisionModel(doc), Plan: fakePlanModel(calls) }
  );
  assert.strictEqual(r.applied, false);
  assert.strictEqual(doc.status, 'rejected');
  assert.strictEqual(calls.length, 0);
});

test('respond: adjusted applies the ADJUSTED ops and stores the diff', async () => {
  const doc = fakeDecisionDoc();
  const calls = [];
  const adjustedOps = [{ op: 'set_task_status', taskId: 't2', status: 'complete' }];
  await svc.respond(
    { decisionId: doc._id, userId: String(doc.userId), response: 'adjusted', adjustedOps },
    { AgentDecision: fakeDecisionModel(doc), Plan: fakePlanModel(calls) }
  );
  assert.strictEqual(doc.status, 'adjusted');
  assert.deepStrictEqual(doc.adjustmentDiff, adjustedOps);
  assert.deepStrictEqual(calls[0].opts.arrayFilters, [{ 't.taskId': 't2' }]);
});

test('respond: wrong owner is refused', async () => {
  const doc = fakeDecisionDoc();
  await assert.rejects(
    () => svc.respond(
      { decisionId: doc._id, userId: String(new mongoose.Types.ObjectId()), response: 'accepted' },
      { AgentDecision: fakeDecisionModel(doc), Plan: fakePlanModel([]) }
    ),
    /not found/
  );
});

test('respond: non-pending decision is refused (idempotency)', async () => {
  const doc = fakeDecisionDoc({ status: 'accepted' });
  await assert.rejects(
    () => svc.respond(
      { decisionId: doc._id, userId: String(doc.userId), response: 'accepted' },
      { AgentDecision: fakeDecisionModel(doc), Plan: fakePlanModel([]) }
    ),
    /already/
  );
});

// ---- expireStale ---------------------------------------------------------
test('expireStale: sweeps pending older than cutoff to ignored', async () => {
  const model = fakeDecisionModel(null);
  const r = await svc.expireStale({ hours: 48 }, { AgentDecision: model });
  assert.strictEqual(r.expired, 3);
  assert.strictEqual(fakeDecisionModel.lastSweep.filter.status, 'pending');
  assert.ok(fakeDecisionModel.lastSweep.filter.createdAt.$lt instanceof Date);
  assert.strictEqual(fakeDecisionModel.lastSweep.update.$set.status, 'ignored');
});
