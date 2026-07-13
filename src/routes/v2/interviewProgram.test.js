'use strict';

const { test } = require('node:test');
const assert = require('assert');

const { makeHandlers } = require('./interviewProgram');

function res() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

// ── POST / (create) ─────────────────────────────────────────────────────

test('createHandler: happy path creates then returns the shaped program', async () => {
  const shaped = { status: 'active', target: { role: 'SWE', company: null, driveDate: null } };
  let createCalled = null;
  const h = makeHandlers({
    isAgentEnabled: () => true,
    createProgram: async (args) => { createCalled = args; return {}; },
    getProgram: async ({ userId }) => { assert.strictEqual(userId, 'u1'); return shaped; },
  });
  const r = res();
  await h.createHandler({ user: { userId: 'u1' }, body: { targetRole: 'SWE' } }, r);
  assert.strictEqual(r.statusCode, 200);
  assert.deepStrictEqual(r.body, { success: true, data: { program: shaped } });
  assert.strictEqual(createCalled.userId, 'u1');
  assert.strictEqual(createCalled.targetRole, 'SWE');
});

test('createHandler: missing targetRole -> 400', async () => {
  const h = makeHandlers({
    isAgentEnabled: () => true,
    createProgram: async () => { throw new Error('should not run'); },
    getProgram: async () => { throw new Error('should not run'); },
  });
  const r = res();
  await h.createHandler({ user: { userId: 'u1' }, body: {} }, r);
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(r.body.success, false);
});

test('createHandler: service "already active" -> 409', async () => {
  const h = makeHandlers({
    isAgentEnabled: () => true,
    createProgram: async () => { throw new Error('program already active'); },
  });
  const r = res();
  await h.createHandler({ user: { userId: 'u1' }, body: { targetRole: 'SWE' } }, r);
  assert.strictEqual(r.statusCode, 409);
  assert.strictEqual(r.body.success, false);
});

test('createHandler: flag off -> 404 envelope (house convention)', async () => {
  const h = makeHandlers({
    isAgentEnabled: () => false,
    createProgram: async () => { throw new Error('should not run'); },
  });
  const r = res();
  await h.createHandler({ user: { userId: 'u1' }, body: { targetRole: 'SWE' } }, r);
  assert.strictEqual(r.statusCode, 404);
  assert.strictEqual(r.body.success, false);
});

// ── GET / ────────────────────────────────────────────────────────────────

test('getHandler: returns the shaped program', async () => {
  const shaped = { status: 'active', focus: { dimension: 'content' } };
  const h = makeHandlers({
    isAgentEnabled: () => true,
    getProgram: async ({ userId }) => { assert.strictEqual(userId, 'u1'); return shaped; },
  });
  const r = res();
  await h.getHandler({ user: { userId: 'u1' } }, r);
  assert.strictEqual(r.statusCode, 200);
  assert.deepStrictEqual(r.body, { success: true, data: { program: shaped } });
});

test('getHandler: no active program -> {program:null} (not an error)', async () => {
  const h = makeHandlers({ isAgentEnabled: () => true, getProgram: async () => null });
  const r = res();
  await h.getHandler({ user: { userId: 'u1' } }, r);
  assert.strictEqual(r.statusCode, 200);
  assert.deepStrictEqual(r.body, { success: true, data: { program: null } });
});

test('getHandler: flag off -> 404 envelope', async () => {
  const h = makeHandlers({ isAgentEnabled: () => false, getProgram: async () => { throw new Error('should not run'); } });
  const r = res();
  await h.getHandler({ user: { userId: 'u1' } }, r);
  assert.strictEqual(r.statusCode, 404);
  assert.strictEqual(r.body.success, false);
});

// ── POST /abandon ────────────────────────────────────────────────────────

test('abandonHandler: idempotent — always 200 with the {abandoned} boolean, active or not', async () => {
  const h = makeHandlers({
    isAgentEnabled: () => true,
    abandonProgram: async ({ userId }) => { assert.strictEqual(userId, 'u1'); return { abandoned: true }; },
  });
  const r1 = res();
  await h.abandonHandler({ user: { userId: 'u1' } }, r1);
  assert.strictEqual(r1.statusCode, 200);
  assert.deepStrictEqual(r1.body, { success: true, data: { abandoned: true } });

  const h2 = makeHandlers({ isAgentEnabled: () => true, abandonProgram: async () => ({ abandoned: false }) });
  const r2 = res();
  await h2.abandonHandler({ user: { userId: 'u1' } }, r2);
  assert.strictEqual(r2.statusCode, 200);
  assert.deepStrictEqual(r2.body, { success: true, data: { abandoned: false } });
});

test('abandonHandler: flag off -> 404 envelope', async () => {
  const h = makeHandlers({ isAgentEnabled: () => false, abandonProgram: async () => { throw new Error('should not run'); } });
  const r = res();
  await h.abandonHandler({ user: { userId: 'u1' } }, r);
  assert.strictEqual(r.statusCode, 404);
  assert.strictEqual(r.body.success, false);
});
