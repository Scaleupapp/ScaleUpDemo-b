'use strict';
/**
 * Unit tests for src/workers/assessmentSync.worker.js — runSyncTick().
 * All injected: no Redis, no Mongo, no BullMQ.
 */
const test = require('node:test');
const assert = require('node:assert');
const { runSyncTick } = require('../../workers/assessmentSync.worker');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSession(overrides = {}) {
  return {
    _id: `sess-${Math.random()}`,
    assessmentId: 'assess1',
    status: 'in_progress',
    save: async function () { return this; },
    ...overrides,
  };
}

function makeAssessment(overrides = {}) {
  return {
    _id: 'assess1',
    closesAt: new Date(Date.now() + 86400_000), // closes tomorrow by default
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('runSyncTick: calls syncSession for each in_progress session', async () => {
  const sessions = [makeSession({ _id: 's1' }), makeSession({ _id: 's2' })];
  const called = [];

  const deps = {
    AssessmentSession: { find: async () => sessions },
    Assessment: { findById: async () => makeAssessment() },
    syncSession: async (id) => { called.push(String(id)); },
    now: () => new Date(),
  };

  await runSyncTick(deps);
  assert.deepStrictEqual(called.sort(), [String(sessions[0]._id), String(sessions[1]._id)].sort(),
    'syncSession called once per in_progress session');
});

test('runSyncTick: marks session expired when closesAt has passed and session is still in_progress', async () => {
  const session = makeSession({ _id: 'sExp' });
  const pastClose = new Date(Date.now() - 1000); // already closed
  let syncCalled = false;

  const deps = {
    AssessmentSession: { find: async () => [session] },
    Assessment: { findById: async () => makeAssessment({ closesAt: pastClose }) },
    syncSession: async () => { syncCalled = true; },
    now: () => new Date(),
  };

  await runSyncTick(deps);
  assert.strictEqual(session.status, 'expired', 'session must be marked expired');
  assert.strictEqual(syncCalled, false, 'syncSession must NOT be called for an expired session');
});

test('runSyncTick: a syncSession throw does not abort the batch (remaining sessions still processed)', async () => {
  const s1 = makeSession({ _id: 'sFail' });
  const s2 = makeSession({ _id: 'sOk' });
  const called = [];

  const deps = {
    AssessmentSession: { find: async () => [s1, s2] },
    Assessment: { findById: async () => makeAssessment() },
    syncSession: async (id) => {
      if (String(id) === String(s1._id)) throw new Error('ENGINE_DOWN');
      called.push(String(id));
    },
    now: () => new Date(),
  };

  // Must not throw even though s1 fails.
  await assert.doesNotReject(() => runSyncTick(deps));
  assert.deepStrictEqual(called, [String(s2._id)], 'second session still processed after first throws');
});

test('runSyncTick: no sessions → completes without error and syncSession not called', async () => {
  let syncCalled = false;
  const deps = {
    AssessmentSession: { find: async () => [] },
    Assessment: { findById: async () => makeAssessment() },
    syncSession: async () => { syncCalled = true; },
    now: () => new Date(),
  };

  await assert.doesNotReject(() => runSyncTick(deps));
  assert.strictEqual(syncCalled, false);
});

test('runSyncTick: session with no closesAt on assessment is not expired (syncSession called)', async () => {
  const session = makeSession({ _id: 'sNoDl' });
  const called = [];

  const deps = {
    AssessmentSession: { find: async () => [session] },
    // Assessment with no closesAt (open-ended)
    Assessment: { findById: async () => makeAssessment({ closesAt: undefined }) },
    syncSession: async (id) => { called.push(String(id)); },
    now: () => new Date(),
  };

  await runSyncTick(deps);
  assert.strictEqual(session.status, 'in_progress', 'session must stay in_progress');
  assert.deepStrictEqual(called, [String(session._id)], 'syncSession called for open-ended assessment');
});
