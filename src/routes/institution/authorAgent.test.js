'use strict';

const { test } = require('node:test');
const assert = require('assert');
const mongoose = require('mongoose');

const { makeHandlers } = require('./authorAgent');

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
    body: {},
    ...overrides,
  };
}

test('POST author-agent: happy path returns decisionId', async () => {
  const decisionId = new mongoose.Types.ObjectId();
  const h = makeHandlers({
    isAgentEnabled: () => true,
    Assessment: {
      findById: (id) => ({
        select: async () => {
          assert.strictEqual(id, 'a1');
          return { institutionId: 'inst1', cohortId: 'c1' };
        },
      }),
    },
    startRun: async ({ assessmentId, institutionId, cohortId, actorInstitutionUserId, brief }) => {
      assert.strictEqual(assessmentId, 'a1');
      assert.strictEqual(institutionId, 'inst1');
      assert.strictEqual(cohortId, 'c1');
      assert.strictEqual(actorInstitutionUserId, 'iu1');
      assert.strictEqual(brief, 'Write hard MCQs on closures');
      return { decisionId };
    },
  });
  const r = res();
  await h.startRunHandler(
    baseReq({ params: { id: 'a1' }, body: { brief: 'Write hard MCQs on closures' } }),
    r
  );
  assert.strictEqual(r.statusCode, 200);
  assert.deepStrictEqual(r.body, { success: true, data: { decisionId: String(decisionId) } });
});

test('POST author-agent: flag off -> 404 envelope', async () => {
  const h = makeHandlers({
    isAgentEnabled: () => false,
    startRun: async () => { throw new Error('should not run'); },
  });
  const r = res();
  await h.startRunHandler(baseReq({ params: { id: 'a1' }, body: { brief: 'x' } }), r);
  assert.strictEqual(r.statusCode, 404);
  assert.strictEqual(r.body.success, false);
});

test('POST author-agent: missing brief -> 400', async () => {
  const h = makeHandlers({
    isAgentEnabled: () => true,
    startRun: async () => { throw new Error('should not run'); },
  });
  const r = res();
  await h.startRunHandler(baseReq({ params: { id: 'a1' }, body: {} }), r);
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(r.body.success, false);
});

test('POST author-agent: service "not authorable" -> 409', async () => {
  const h = makeHandlers({
    isAgentEnabled: () => true,
    Assessment: {
      findById: () => ({ select: async () => ({ institutionId: 'inst1', cohortId: 'c1' }) }),
    },
    startRun: async () => { throw new Error('assessment not authorable'); },
  });
  const r = res();
  await h.startRunHandler(baseReq({ params: { id: 'a1' }, body: { brief: 'x' } }), r);
  assert.strictEqual(r.statusCode, 409);
  assert.strictEqual(r.body.success, false);
});

test('GET author-agent run status: happy path returns status/runLog/result', async () => {
  const decisionId = new mongoose.Types.ObjectId();
  const h = makeHandlers({
    isAgentEnabled: () => true,
    getRunStatus: async ({ decisionId: id, institutionId }) => {
      assert.strictEqual(String(id), String(decisionId));
      assert.strictEqual(institutionId, 'inst1');
      return { status: 'ready', runLog: [{ at: new Date(), msg: 'ready' }], result: { status: 'ready' } };
    },
  });
  const r = res();
  await h.getRunStatusHandler(baseReq({ params: { decisionId: String(decisionId) } }), r);
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.body.success, true);
  assert.strictEqual(r.body.data.status, 'ready');
  assert.ok(Array.isArray(r.body.data.runLog));
  assert.deepStrictEqual(r.body.data.result, { status: 'ready' });
});

test('GET author-agent run status: "run not found" -> 404', async () => {
  const h = makeHandlers({
    isAgentEnabled: () => true,
    getRunStatus: async () => { throw new Error('run not found'); },
  });
  const r = res();
  await h.getRunStatusHandler(baseReq({ params: { decisionId: 'x' } }), r);
  assert.strictEqual(r.statusCode, 404);
  assert.strictEqual(r.body.success, false);
});
