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

test('POST author-agent: service "already in progress" (concurrent run guard) -> 409', async () => {
  const h = makeHandlers({
    isAgentEnabled: () => true,
    Assessment: {
      findById: () => ({ select: async () => ({ institutionId: 'inst1', cohortId: 'c1' }) }),
    },
    startRun: async () => { throw new Error('assessment authoring already in progress'); },
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

// ── Plan 7, Task 2: route accepts every engine (no mcq-specific gate here — ──
// ── the route never checked assessment.type; authorAgentService owns that). ──

test('POST author-agent: succeeds for a capstone assessment (DI fake service)', async () => {
  const decisionId = new mongoose.Types.ObjectId();
  const h = makeHandlers({
    isAgentEnabled: () => true,
    Assessment: {
      findById: (id) => ({
        select: async () => {
          assert.strictEqual(id, 'cap1');
          // type isn't even selected by the route (service owns that guard) —
          // this fixture just mirrors what a capstone assessment looks like.
          return { institutionId: 'inst1', cohortId: 'c-capstone', type: 'capstone' };
        },
      }),
    },
    startRun: async ({ assessmentId, institutionId, cohortId, brief }) => {
      assert.strictEqual(assessmentId, 'cap1');
      assert.strictEqual(institutionId, 'inst1');
      assert.strictEqual(cohortId, 'c-capstone');
      assert.strictEqual(brief, 'payment service with seeded bugs, 90 min');
      return { decisionId };
    },
  });
  const r = res();
  await h.startRunHandler(
    baseReq({ params: { id: 'cap1' }, body: { brief: 'payment service with seeded bugs, 90 min' } }),
    r
  );
  assert.strictEqual(r.statusCode, 200);
  assert.deepStrictEqual(r.body, { success: true, data: { decisionId: String(decisionId) } });
});

test('POST author-agent: service "assessment not authorable" for a released assessment -> 409', async () => {
  const h = makeHandlers({
    isAgentEnabled: () => true,
    Assessment: {
      findById: () => ({ select: async () => ({ institutionId: 'inst1', cohortId: 'c1' }) }),
    },
    startRun: async () => { throw new Error('assessment not authorable'); },
  });
  const r = res();
  await h.startRunHandler(baseReq({ params: { id: 'released1' }, body: { brief: 'x' } }), r);
  assert.strictEqual(r.statusCode, 409);
  assert.strictEqual(r.body.success, false);
});

// ── POST /agent/create-assessment — the one-prompt path ──────────────────

test('POST agent/create-assessment: happy path returns assessmentId/decisionId/spec', async () => {
  const spec = { type: 'mcq', title: 'Aptitude Test', config: { mcq: { topic: 'Aptitude' } } };
  const h = makeHandlers({
    isAgentEnabled: () => true,
    createAndAuthor: async ({ institutionId, cohortId, actorInstitutionUserId, brief }) => {
      assert.strictEqual(institutionId, 'inst1');
      assert.strictEqual(cohortId, 'c1');
      assert.strictEqual(actorInstitutionUserId, 'iu1');
      assert.strictEqual(brief, '20-question aptitude MCQ, 30 minutes');
      return { assessmentId: 'a1', decisionId: 'dec1', spec };
    },
  });
  const r = res();
  await h.createAssessmentHandler(
    baseReq({ body: { cohortId: 'c1', brief: '20-question aptitude MCQ, 30 minutes' } }),
    r
  );
  assert.strictEqual(r.statusCode, 200);
  assert.deepStrictEqual(r.body, {
    success: true,
    data: { assessmentId: 'a1', decisionId: 'dec1', spec },
  });
});

test('POST agent/create-assessment: flag off -> 404 envelope', async () => {
  const h = makeHandlers({
    isAgentEnabled: () => false,
    createAndAuthor: async () => { throw new Error('should not run'); },
  });
  const r = res();
  await h.createAssessmentHandler(baseReq({ body: { cohortId: 'c1', brief: 'x' } }), r);
  assert.strictEqual(r.statusCode, 404);
  assert.strictEqual(r.body.success, false);
});

test('POST agent/create-assessment: missing cohortId -> 400', async () => {
  const h = makeHandlers({
    isAgentEnabled: () => true,
    createAndAuthor: async () => { throw new Error('should not run'); },
  });
  const r = res();
  await h.createAssessmentHandler(baseReq({ body: { brief: 'x' } }), r);
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(r.body.success, false);
});

test('POST agent/create-assessment: missing brief -> 400', async () => {
  const h = makeHandlers({
    isAgentEnabled: () => true,
    createAndAuthor: async () => { throw new Error('should not run'); },
  });
  const r = res();
  await h.createAssessmentHandler(baseReq({ body: { cohortId: 'c1' } }), r);
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(r.body.success, false);
});

test('POST agent/create-assessment: cohort not found -> 404', async () => {
  const h = makeHandlers({
    isAgentEnabled: () => true,
    createAndAuthor: async () => { throw new Error('cohort not found'); },
  });
  const r = res();
  await h.createAssessmentHandler(baseReq({ body: { cohortId: 'nope', brief: 'x' } }), r);
  assert.strictEqual(r.statusCode, 404);
  assert.strictEqual(r.body.success, false);
});

test('POST agent/create-assessment: unparseable brief -> 422', async () => {
  const h = makeHandlers({
    isAgentEnabled: () => true,
    createAndAuthor: async () => { throw new Error('could not understand the brief'); },
  });
  const r = res();
  await h.createAssessmentHandler(baseReq({ body: { cohortId: 'c1', brief: 'asdkjfh' } }), r);
  assert.strictEqual(r.statusCode, 422);
  assert.strictEqual(r.body.success, false);
});

test('POST agent/create-assessment: unexpected service error -> 500', async () => {
  const h = makeHandlers({
    isAgentEnabled: () => true,
    createAndAuthor: async () => { throw new Error('boom'); },
  });
  const r = res();
  await h.createAssessmentHandler(baseReq({ body: { cohortId: 'c1', brief: 'x' } }), r);
  assert.strictEqual(r.statusCode, 500);
  assert.strictEqual(r.body.success, false);
});

// ── GET /author-agent/runs — list recent runs for a cohort ────────────────

test('GET author-agent/runs: happy path returns runs from the service, scoped by the authed institution', async () => {
  const runs = [
    { decisionId: 'dec2', assessmentId: 'a2', assessmentTitle: 'Newest', engine: 'mcq', status: 'ready', createdAt: new Date() },
    { decisionId: 'dec1', assessmentId: 'a1', assessmentTitle: 'Oldest', engine: 'drill', status: 'generating', createdAt: new Date() },
  ];
  const h = makeHandlers({
    isAgentEnabled: () => true,
    listRuns: async ({ institutionId, cohortId, limit }) => {
      assert.strictEqual(institutionId, 'inst1');
      assert.strictEqual(cohortId, 'c1');
      assert.strictEqual(limit, undefined);
      return { runs };
    },
  });
  const r = res();
  await h.listRunsHandler(baseReq({ query: { cohortId: 'c1' } }), r);
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.body.success, true);
  assert.deepStrictEqual(r.body.data.runs, runs);
});

test('GET author-agent/runs: passes a numeric limit through to the service', async () => {
  let capturedLimit;
  const h = makeHandlers({
    isAgentEnabled: () => true,
    listRuns: async ({ limit }) => { capturedLimit = limit; return { runs: [] }; },
  });
  const r = res();
  await h.listRunsHandler(baseReq({ query: { cohortId: 'c1', limit: '3' } }), r);
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(capturedLimit, 3);
});

test('GET author-agent/runs: missing cohortId -> 400', async () => {
  const h = makeHandlers({
    isAgentEnabled: () => true,
    listRuns: async () => { throw new Error('should not run'); },
  });
  const r = res();
  await h.listRunsHandler(baseReq({ query: {} }), r);
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(r.body.success, false);
});

test('GET author-agent/runs: flag off -> 404 envelope', async () => {
  const h = makeHandlers({
    isAgentEnabled: () => false,
    listRuns: async () => { throw new Error('should not run'); },
  });
  const r = res();
  await h.listRunsHandler(baseReq({ query: { cohortId: 'c1' } }), r);
  assert.strictEqual(r.statusCode, 404);
  assert.strictEqual(r.body.success, false);
});

test('GET author-agent/runs: cross-tenant cohort -> empty list, not an error (service does the scoping)', async () => {
  const h = makeHandlers({
    isAgentEnabled: () => true,
    listRuns: async ({ institutionId, cohortId }) => {
      assert.strictEqual(institutionId, 'inst1');
      assert.strictEqual(cohortId, 'other-institutions-cohort');
      return { runs: [] };
    },
  });
  const r = res();
  await h.listRunsHandler(baseReq({ query: { cohortId: 'other-institutions-cohort' } }), r);
  assert.strictEqual(r.statusCode, 200);
  assert.deepStrictEqual(r.body.data.runs, []);
});

test('GET author-agent/runs: in-progress run surfaces status "generating"', async () => {
  const runs = [{ decisionId: 'dec1', assessmentId: 'a1', assessmentTitle: 'T', engine: 'mcq', status: 'generating', createdAt: new Date() }];
  const h = makeHandlers({
    isAgentEnabled: () => true,
    listRuns: async () => ({ runs }),
  });
  const r = res();
  await h.listRunsHandler(baseReq({ query: { cohortId: 'c1' } }), r);
  assert.strictEqual(r.body.data.runs[0].status, 'generating');
});

test('GET author-agent/runs: unexpected service error -> 500', async () => {
  const h = makeHandlers({
    isAgentEnabled: () => true,
    listRuns: async () => { throw new Error('boom'); },
  });
  const r = res();
  await h.listRunsHandler(baseReq({ query: { cohortId: 'c1' } }), r);
  assert.strictEqual(r.statusCode, 500);
  assert.strictEqual(r.body.success, false);
});

// ── back to author-agent run status coverage ──────────────────────────────

test('GET author-agent run status: passes through engine + evidence', async () => {
  const decisionId = new mongoose.Types.ObjectId();
  const evidence = { bundleId: 'b1', bundleStatus: 'active', roleTrack: 'backend', difficulty: 'medium', language: 'python', humanReviewed: true };
  const h = makeHandlers({
    isAgentEnabled: () => true,
    getRunStatus: async ({ decisionId: id, institutionId }) => {
      assert.strictEqual(String(id), String(decisionId));
      assert.strictEqual(institutionId, 'inst1');
      return {
        status: 'ready',
        runLog: [{ at: new Date(), msg: 'bundle promoted to active' }],
        result: { status: 'ready', engine: 'capstone', evidence, flagged: [], passes: 0 },
      };
    },
  });
  const r = res();
  await h.getRunStatusHandler(baseReq({ params: { decisionId: String(decisionId) } }), r);
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.body.success, true);
  assert.strictEqual(r.body.data.result.engine, 'capstone');
  assert.deepStrictEqual(r.body.data.result.evidence, evidence);
});
