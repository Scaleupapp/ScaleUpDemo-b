'use strict';

const { test } = require('node:test');
const assert = require('assert');

const { makeHandlers } = require('./proofJourney');

function res() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

// ── POST / (create) ─────────────────────────────────────────────────────

test('createHandler: happy path starts the journey and returns it', async () => {
  const journey = { _id: 'j1', status: 'extracting' };
  let startCalled = null;
  const h = makeHandlers({
    isAgentEnabled: () => true,
    startJourney: async (args) => { startCalled = args; return journey; },
  });
  const r = res();
  await h.createHandler({ user: { userId: 'u1' }, body: { jdText: 'we need a backend engineer' } }, r);
  assert.strictEqual(r.statusCode, 200);
  assert.deepStrictEqual(r.body, { success: true, data: { journey } });
  assert.strictEqual(startCalled.userId, 'u1');
  assert.strictEqual(startCalled.jdText, 'we need a backend engineer');
});

test('createHandler: missing jdText -> 400', async () => {
  const h = makeHandlers({
    isAgentEnabled: () => true,
    startJourney: async () => { throw new Error('should not run'); },
  });
  const r = res();
  await h.createHandler({ user: { userId: 'u1' }, body: {} }, r);
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(r.body.success, false);
});

test('createHandler: blank jdText -> 400', async () => {
  const h = makeHandlers({
    isAgentEnabled: () => true,
    startJourney: async () => { throw new Error('should not run'); },
  });
  const r = res();
  await h.createHandler({ user: { userId: 'u1' }, body: { jdText: '   ' } }, r);
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(r.body.success, false);
});

test('createHandler: flag off -> 404 envelope (house convention)', async () => {
  const h = makeHandlers({
    isAgentEnabled: () => false,
    startJourney: async () => { throw new Error('should not run'); },
  });
  const r = res();
  await h.createHandler({ user: { userId: 'u1' }, body: { jdText: 'jd' } }, r);
  assert.strictEqual(r.statusCode, 404);
  assert.strictEqual(r.body.success, false);
});

// ── GET / ────────────────────────────────────────────────────────────────

test('getHandler: returns the shaped journey', async () => {
  const journey = { _id: 'j1', status: 'publishable' };
  const h = makeHandlers({
    isAgentEnabled: () => true,
    getJourney: async ({ userId }) => { assert.strictEqual(userId, 'u1'); return journey; },
  });
  const r = res();
  await h.getHandler({ user: { userId: 'u1' } }, r);
  assert.strictEqual(r.statusCode, 200);
  assert.deepStrictEqual(r.body, { success: true, data: { journey } });
});

test('getHandler: no journey -> {journey:null} (not an error)', async () => {
  const h = makeHandlers({ isAgentEnabled: () => true, getJourney: async () => null });
  const r = res();
  await h.getHandler({ user: { userId: 'u1' } }, r);
  assert.strictEqual(r.statusCode, 200);
  assert.deepStrictEqual(r.body, { success: true, data: { journey: null } });
});

test('getHandler: flag off -> 404 envelope', async () => {
  const h = makeHandlers({ isAgentEnabled: () => false, getJourney: async () => { throw new Error('should not run'); } });
  const r = res();
  await h.getHandler({ user: { userId: 'u1' } }, r);
  assert.strictEqual(r.statusCode, 404);
  assert.strictEqual(r.body.success, false);
});

// ── POST /publish ────────────────────────────────────────────────────────

test('publishHandler: happy path publishes and returns the journey', async () => {
  const journey = { _id: 'j1', status: 'published', proofToken: 'tok-1' };
  const h = makeHandlers({
    isAgentEnabled: () => true,
    publishProof: async ({ userId }) => { assert.strictEqual(userId, 'u1'); return journey; },
  });
  const r = res();
  await h.publishHandler({ user: { userId: 'u1' } }, r);
  assert.strictEqual(r.statusCode, 200);
  assert.deepStrictEqual(r.body, { success: true, data: { journey } });
});

test('publishHandler: guard — not publishable -> 409', async () => {
  const h = makeHandlers({
    isAgentEnabled: () => true,
    publishProof: async () => { throw new Error('proof journey is not publishable yet'); },
  });
  const r = res();
  await h.publishHandler({ user: { userId: 'u1' } }, r);
  assert.strictEqual(r.statusCode, 409);
  assert.strictEqual(r.body.success, false);
});

test('publishHandler: no journey found -> 404', async () => {
  const h = makeHandlers({
    isAgentEnabled: () => true,
    publishProof: async () => { throw new Error('no proof journey found'); },
  });
  const r = res();
  await h.publishHandler({ user: { userId: 'u1' } }, r);
  assert.strictEqual(r.statusCode, 404);
  assert.strictEqual(r.body.success, false);
});

test('publishHandler: flag off -> 404 envelope', async () => {
  const h = makeHandlers({ isAgentEnabled: () => false, publishProof: async () => { throw new Error('should not run'); } });
  const r = res();
  await h.publishHandler({ user: { userId: 'u1' } }, r);
  assert.strictEqual(r.statusCode, 404);
  assert.strictEqual(r.body.success, false);
});
