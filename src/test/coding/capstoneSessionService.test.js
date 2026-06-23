'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startSession, abortNeverStartedSessions } = require('../../coding/services/capstoneSessionService');

test('startSession happy path: creates session with snake_case fields, fires provision (non-blocking), returns {session, timeBudgetSeconds}', async () => {
  let createdDoc = null;
  let provisionCalledWith = null;
  const fakeBundle = { _id: 'b1', type: 'capstone', time_budget_minutes: 90 };
  const deps = {
    ArtifactBundle: { findById: async () => fakeBundle },
    CapstoneSession: {
      find: async () => ({ select: () => ({ lean: async () => [] }) }),
      create: async (d) => { createdDoc = d; return { _id: 'sess1', ...d, time_budget_seconds: d.time_budget_seconds }; },
    },
    sandboxOrchestrator: { provisionForSession: (id) => { provisionCalledWith = id; return Promise.resolve(); } },
    applyControl: async () => {},
  };
  const result = await startSession({ userId: 'u1', bundleId: 'b1' }, deps);
  assert.strictEqual(createdDoc.user_id, 'u1');
  assert.strictEqual(String(createdDoc.bundle_id), 'b1');
  assert.strictEqual(createdDoc.status, 'scheduled');
  assert.strictEqual(createdDoc.time_budget_seconds, 90 * 60);
  assert.ok(result.session);
  assert.strictEqual(result.timeBudgetSeconds, 90 * 60);
  assert.ok(provisionCalledWith);
});

test('startSession throws BUNDLE_NOT_FOUND when bundle missing', async () => {
  const deps = {
    ArtifactBundle: { findById: async () => null },
    CapstoneSession: { find: async () => ({ select: () => ({ lean: async () => [] }) }), create: async () => { throw new Error('should not reach'); } },
    sandboxOrchestrator: { provisionForSession: async () => {} },
    applyControl: async () => {},
  };
  await assert.rejects(() => startSession({ userId: 'u1', bundleId: 'missing' }, deps), /BUNDLE_NOT_FOUND/);
});

test('startSession throws NOT_A_CAPSTONE when bundle.type !== capstone', async () => {
  const deps = {
    ArtifactBundle: { findById: async () => ({ _id: 'b1', type: 'drill', time_budget_minutes: 60 }) },
    CapstoneSession: { find: async () => ({ select: () => ({ lean: async () => [] }) }), create: async () => {} },
    sandboxOrchestrator: { provisionForSession: async () => {} },
    applyControl: async () => {},
  };
  await assert.rejects(() => startSession({ userId: 'u1', bundleId: 'b1' }, deps), /NOT_A_CAPSTONE/);
});

test('abortNeverStartedSessions calls applyControl abort for each stale session', async () => {
  const abortCalls = [];
  const stale = [{ _id: 's1' }, { _id: 's2' }];
  const deps = {
    CapstoneSession: {
      find: () => ({ select: () => ({ lean: async () => stale }) }),
    },
    applyControl: async ({ sessionId, action }) => { abortCalls.push({ sessionId, action }); },
  };
  await abortNeverStartedSessions('u1', deps);
  assert.strictEqual(abortCalls.length, 2);
  assert.ok(abortCalls.every(c => c.action === 'abort'));
});
