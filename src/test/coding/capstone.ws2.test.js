'use strict';

/**
 * WS2 unit tests — pure function + mocked-model coverage for the capstone
 * session lifecycle. No Mongo, no Redis, no e2b.
 *
 * Three suites:
 *   1. sessionStateMachine — transition map completeness + isAllowed semantics
 *   2. pairingService — collision retry + redeem branching, via mocked model
 *   3. recordingService — event dedup window (in-memory only)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// 1. sessionStateMachine
// ---------------------------------------------------------------------------

const { ALLOWED, isAllowed } = require('../../coding/services/sessionStateMachine');

test('state machine: every CapstoneSession status enum value is a node in the graph', () => {
  // Anchor on the OpenAPI enum so spec drift breaks loudly. Lazy require
  // because openapi.yaml is loaded as YAML elsewhere — this test reads
  // the model's enum directly which is fine for parity.
  const statuses = require('../../coding/models/capstoneSession.model').schema.path('status').enumValues;
  for (const s of statuses) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(ALLOWED, s),
      `state machine missing node for status "${s}"`
    );
  }
});

test('state machine: forward edges only go to statuses that also exist as nodes', () => {
  for (const [from, edges] of Object.entries(ALLOWED)) {
    if (edges == null) continue;
    for (const to of edges) {
      assert.ok(ALLOWED[to] !== undefined, `${from} → ${to}: target "${to}" not a node`);
    }
  }
});

test('state machine: terminal states have no outgoing edges', () => {
  for (const t of ['graded', 'aborted']) {
    assert.equal(ALLOWED[t], null, `${t} should be terminal (null edges)`);
  }
});

test('state machine: isAllowed accepts legal edges and rejects illegal ones', () => {
  assert.equal(isAllowed('scheduled', 'provisioning'), true);
  assert.equal(isAllowed('in_progress', 'submitted'), true);
  assert.equal(isAllowed('paused', 'in_progress'), true);
  assert.equal(isAllowed('expired', 'submitted'), true);

  // Backward / invalid
  assert.equal(isAllowed('graded', 'in_progress'), false);
  assert.equal(isAllowed('scheduled', 'submitted'), false);
  assert.equal(isAllowed('ready', 'graded'), false);
  assert.equal(isAllowed('aborted', 'ready'), false);
  assert.equal(isAllowed('not_a_state', 'ready'), false);
});

// ---------------------------------------------------------------------------
// 2. pairingService — mocked PairingCode model
// ---------------------------------------------------------------------------

test('pairingService: mintCode retries on dup-key and surfaces clean code', async () => {
  const modulePath = require.resolve('../../coding/services/pairingService');
  const modelPath = require.resolve('../../coding/models/pairingCode.model');
  const orig = { mod: require.cache[modulePath], model: require.cache[modelPath] };

  let calls = 0;
  const minted = [];
  const mockModel = {
    create: async (doc) => {
      calls += 1;
      // First call dup-keys; second succeeds.
      if (calls === 1) {
        const err = new Error('E11000 duplicate key');
        err.code = 11000;
        throw err;
      }
      minted.push(doc);
      return doc;
    },
    findOneAndUpdate: async () => null,
    findOne: () => ({ lean: async () => null }),
  };
  require.cache[modelPath] = { exports: mockModel, loaded: true, id: modelPath };
  delete require.cache[modulePath];

  try {
    const pairing = require(modulePath);
    const { code, expiresAt } = await pairing.mintCode({
      userId: 'u1',
      sessionId: 's1',
    });
    assert.match(code, /^\d{6}$/, 'code must be 6 digits');
    assert.ok(expiresAt instanceof Date);
    assert.equal(calls, 2, 'should have retried once');
    assert.equal(minted.length, 1);
    assert.equal(minted[0].user_id, 'u1');
  } finally {
    if (orig.mod) require.cache[modulePath] = orig.mod; else delete require.cache[modulePath];
    if (orig.model) require.cache[modelPath] = orig.model; else delete require.cache[modelPath];
  }
});

test('pairingService: redeem branches by kind (ok | invalid | expired | used)', async () => {
  const modulePath = require.resolve('../../coding/services/pairingService');
  const modelPath = require.resolve('../../coding/models/pairingCode.model');
  const orig = { mod: require.cache[modulePath], model: require.cache[modelPath] };

  // We mutate this per assertion below.
  let updateResult = null;
  let peekResult = null;
  const mockModel = {
    findOneAndUpdate: async () => updateResult,
    findOne: () => ({ lean: async () => peekResult }),
    create: async () => ({}),
  };
  require.cache[modelPath] = { exports: mockModel, loaded: true, id: modelPath };
  delete require.cache[modulePath];

  try {
    const pairing = require(modulePath);

    // (a) ok
    updateResult = {
      code: '123456',
      user_id: 'u1',
      session_id: 's1',
      used_at: new Date(),
    };
    let r = await pairing.redeem('123456');
    assert.equal(r.kind, 'ok');
    assert.equal(r.userId, 'u1');

    // (b) used — update missed because used_at is set
    updateResult = null;
    peekResult = { used_at: new Date(), expires_at: new Date(Date.now() + 60_000) };
    r = await pairing.redeem('000001');
    assert.equal(r.kind, 'used');

    // (c) expired — update missed because expires_at is past
    peekResult = { used_at: null, expires_at: new Date(Date.now() - 1_000) };
    r = await pairing.redeem('000002');
    assert.equal(r.kind, 'expired');

    // (d) invalid — code doesn't exist
    peekResult = null;
    r = await pairing.redeem('000003');
    assert.equal(r.kind, 'invalid');

    // (e) empty / non-string input
    assert.equal((await pairing.redeem()).kind, 'invalid');
    assert.equal((await pairing.redeem(null)).kind, 'invalid');
  } finally {
    if (orig.mod) require.cache[modulePath] = orig.mod; else delete require.cache[modulePath];
    if (orig.model) require.cache[modelPath] = orig.model; else delete require.cache[modelPath];
  }
});

// ---------------------------------------------------------------------------
// 3. recordingService — dedup window for file_write events
// ---------------------------------------------------------------------------

test('recordingService: dedups file_write events for same path within DEDUP_WINDOW_MS', () => {
  const modulePath = require.resolve('../../coding/services/recordingService');
  // Reset module so the in-process buffer Map is clean.
  delete require.cache[modulePath];
  const recording = require(modulePath);

  const sessionId = 'session-dedup-1';
  // Seed a buffer manually so we don't trigger the auto-flush S3 path.
  recording._buffers.set(sessionId, {
    events: [],
    bytes: 0,
    seqNext: 0,
    lastFlushAt: 0,
    dedupCache: new Map(),
    timer: null,
  });

  // 5 writes to the same path in quick succession → first only is recorded.
  for (let i = 0; i < 5; i++) {
    recording.emit(sessionId, { type: 'file_write', payload: { path: 'src/index.js' } });
  }
  const buf = recording._buffers.get(sessionId);
  assert.equal(buf.events.length, 1, 'dedup window should suppress 4 of 5 rapid writes');

  // Writes to a DIFFERENT path within the same window are recorded.
  recording.emit(sessionId, { type: 'file_write', payload: { path: 'src/other.js' } });
  assert.equal(buf.events.length, 2);

  // Non-file_write events are never deduped, even with same payload.
  recording.emit(sessionId, { type: 'compass_turn', payload: { id: 't1' } });
  recording.emit(sessionId, { type: 'compass_turn', payload: { id: 't1' } });
  assert.equal(buf.events.length, 4);

  // After DEDUP_WINDOW_MS the same path is recorded again. Fast-forward by
  // mutating the dedup cache directly (avoids a real setTimeout in tests).
  buf.dedupCache.set('src/index.js', Date.now() - (recording.DEDUP_WINDOW_MS + 100));
  recording.emit(sessionId, { type: 'file_write', payload: { path: 'src/index.js' } });
  assert.equal(buf.events.length, 5);
});
