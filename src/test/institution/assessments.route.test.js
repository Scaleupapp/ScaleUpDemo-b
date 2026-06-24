'use strict';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');
const { signInstitutionToken } = require('../../services/institution/institutionAuthService');
const institutionAuth = require('../../middleware/institutionAuth');

function stubLoadUser(role) {
  institutionAuth._loadUser = async () => ({ _id: 'u1', institutionId: 'i1', role, status: 'active', tokenVersion: 0, scope: {} });
}
const assessments = require('../../routes/institution/assessments');
function tok(role) { return signInstitutionToken({ _id: 'u1', institutionId: 'i1', role, tokenVersion: 0 }); }
function appAs(role) {
  stubLoadUser(role);
  const a = express(); a.use(express.json()); a.use('/api/institution', assessments); return a;
}

test('tpo_head POST /assessments → 201, scoped to token institution, not body', async () => {
  let captured = null;
  assessments._deps = {
    assessmentService: {
      createAssessment: async (scope, payload) => {
        captured = { scope, payload };
        return { _id: 'a1', ...scope, ...payload };
      },
    },
  };
  const res = await request(appAs('tpo_head'))
    .post('/api/institution/assessments')
    .set('Authorization', `Bearer ${tok('tpo_head')}`)
    .send({ cohortId: 'c1', type: 'mcq', title: 'Round 1', institutionId: 'EVIL' });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(String(captured.scope.institutionId), 'i1');  // from token
  assert.notStrictEqual(String(captured.scope.institutionId), 'EVIL'); // body cannot override
  assert.strictEqual(captured.payload.createdBy, 'u1');
  assessments._deps = null;
});

test('POST /assessments → 400 VALIDATION when cohortId/type/title missing', async () => {
  const res = await request(appAs('tpo_head'))
    .post('/api/institution/assessments')
    .set('Authorization', `Bearer ${tok('tpo_head')}`)
    .send({ title: 'Only Title' }); // missing cohortId and type
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.code, 'VALIDATION');
});

test('viewer POST /assessments → 403 (role gate)', async () => {
  const res = await request(appAs('viewer'))
    .post('/api/institution/assessments')
    .set('Authorization', `Bearer ${tok('viewer')}`)
    .send({ cohortId: 'c1', type: 'mcq', title: 'X' });
  assert.strictEqual(res.status, 403);
});

test('tpo_head POST /assessments/:id/release → 200 with status and releasedAt', async () => {
  const fakeReleasedAt = new Date();
  assessments._deps = {
    assessmentService: {
      releaseAssessment: async (scope, id, releasedBy) => ({
        _id: 'a1', status: 'released', releasedAt: fakeReleasedAt,
      }),
    },
  };
  const res = await request(appAs('tpo_head'))
    .post('/api/institution/assessments/a1/release')
    .set('Authorization', `Bearer ${tok('tpo_head')}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.data.status, 'released');
  assert.ok(res.body.data.releasedAt);
  assessments._deps = null;
});

test('POST /assessments/:id/release → 409 BAD_STATUS when assessment is not configured', async () => {
  assessments._deps = {
    assessmentService: {
      releaseAssessment: async () => { throw new Error('BAD_STATUS'); },
    },
  };
  const res = await request(appAs('tpo_head'))
    .post('/api/institution/assessments/a1/release')
    .set('Authorization', `Bearer ${tok('tpo_head')}`);
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.code, 'BAD_STATUS');
  assessments._deps = null;
});

test('tpo_coordinator POST /assessments/:id/release → 403 (maker-checker role gate)', async () => {
  // tpo_coordinator can configure but NOT release (only tpo_head + institution_admin can release)
  const res = await request(appAs('tpo_coordinator'))
    .post('/api/institution/assessments/a1/release')
    .set('Authorization', `Bearer ${tok('tpo_coordinator')}`);
  assert.strictEqual(res.status, 403);
});

test('GET /assessments → 200 scoped list (any institution role)', async () => {
  let capturedScope = null;
  assessments._deps = {
    assessmentService: {
      listAssessments: async (scope, opts) => {
        capturedScope = scope;
        return [{ _id: 'a1', ...scope, title: 'Round 1' }];
      },
    },
  };
  const res = await request(appAs('viewer'))
    .get('/api/institution/assessments')
    .set('Authorization', `Bearer ${tok('viewer')}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(String(capturedScope.institutionId), 'i1');
  assert.strictEqual(res.body.data.length, 1);
  assessments._deps = null;
});

test('GET /assessments/:id → 404 when not found', async () => {
  assessments._deps = {
    assessmentService: {
      getAssessment: async () => null,
    },
  };
  const res = await request(appAs('faculty'))
    .get('/api/institution/assessments/missing')
    .set('Authorization', `Bearer ${tok('faculty')}`);
  assert.strictEqual(res.status, 404);
  assessments._deps = null;
});

// ── Monitoring: GET /assessments/:id/sessions ─────────────────────────────────

test('GET /assessments/:id/sessions hides score while window is still open', async () => {
  const future = new Date(Date.now() + 86400000); // closes tomorrow
  assessments._deps = {
    Assessment: {
      findOne: async () => ({
        _id: 'a1',
        institutionId: 'i1',
        cohortId: 'c1',
        closesAt: future,
      }),
    },
    AssessmentSession: {
      find: async () => [
        { _id: 's1', userId: 'u1', status: 'graded',      result: { score: 92 } },
        { _id: 's2', userId: 'u2', status: 'in_progress', result: null },
      ],
    },
    InstitutionEnrollment: { countDocuments: async () => 2, find: async () => [] },
    User: { find: async () => [] },
  };

  const res = await request(appAs('viewer'))
    .get('/api/institution/assessments/a1/sessions')
    .set('Authorization', `Bearer ${tok('viewer')}`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  const { counts, sessions } = res.body.data;
  assert.strictEqual(counts.graded, 1);
  assert.strictEqual(counts.started, 2);
  // Scores must NOT be present while window is open
  sessions.forEach((s) => assert.strictEqual(s.score, undefined, 'score must be hidden while window is open'));
  assessments._deps = null;
});

test('GET /assessments/:id/sessions shows score after closesAt', async () => {
  const past = new Date(Date.now() - 86400000); // closed yesterday
  assessments._deps = {
    Assessment: {
      findOne: async () => ({
        _id: 'a1',
        institutionId: 'i1',
        cohortId: 'c1',
        closesAt: past,
      }),
    },
    AssessmentSession: {
      find: async () => [
        { _id: 's1', userId: 'u1', status: 'graded', result: { score: 88 } },
      ],
    },
    InstitutionEnrollment: { countDocuments: async () => 1, find: async () => [] },
    User: { find: async () => [] },
  };

  const res = await request(appAs('viewer'))
    .get('/api/institution/assessments/a1/sessions')
    .set('Authorization', `Bearer ${tok('viewer')}`);

  assert.strictEqual(res.status, 200);
  const { sessions } = res.body.data;
  assert.strictEqual(sessions[0].score, 88, 'score should be visible after window closes');
  assessments._deps = null;
});

test('GET /assessments/:id/sessions → 404 when assessment not found', async () => {
  assessments._deps = {
    Assessment: { findOne: async () => null },
    AssessmentSession: { find: async () => [] },
  };

  const res = await request(appAs('viewer'))
    .get('/api/institution/assessments/missing/sessions')
    .set('Authorization', `Bearer ${tok('viewer')}`);

  assert.strictEqual(res.status, 404);
  assessments._deps = null;
});

// ── Analytics: GET /cohorts/:cohortId/assessment-rollup ──────────────────────

test('GET /cohorts/:cohortId/assessment-rollup returns cached rollup doc', async () => {
  const fakeRollup = {
    institutionId: 'i1',
    cohortId: 'c1',
    assessmentId: 'a1',
    counts: { assigned: 30, started: 20, submitted: 18, graded: 18 },
    avgScore: 74,
  };
  assessments._deps = {
    CohortRollup: {
      findOne: async (filter) => {
        assert.strictEqual(String(filter.institutionId), 'i1');
        assert.strictEqual(String(filter.cohortId), 'c1');
        assert.strictEqual(String(filter.assessmentId), 'a1');
        return fakeRollup;
      },
    },
  };

  const res = await request(appAs('viewer'))
    .get('/api/institution/cohorts/c1/assessment-rollup?assessmentId=a1')
    .set('Authorization', `Bearer ${tok('viewer')}`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.data.avgScore, 74);
  assessments._deps = null;
});

test('GET /cohorts/:cohortId/assessment-rollup returns null when no rollup computed yet', async () => {
  assessments._deps = {
    CohortRollup: { findOne: async () => null },
  };

  const res = await request(appAs('viewer'))
    .get('/api/institution/cohorts/c1/assessment-rollup?assessmentId=a1')
    .set('Authorization', `Bearer ${tok('viewer')}`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data, null);
  assessments._deps = null;
});

// ── Authoring trigger tests ───────────────────────────────────────────────────

test('POST /assessments (mcq type) triggers authoringService.authorMcq with assessment id', async () => {
  let authorMcqCalledWithId = null;

  assessments._deps = {
    assessmentService: {
      createAssessment: async (scope, payload) => ({
        _id: 'a-mcq-1',
        type: 'mcq',
        ...scope,
        ...payload,
      }),
    },
    authoringService: {
      // Simulates fire-and-forget: returns a promise that resolves
      authorMcq: async (id) => { authorMcqCalledWithId = String(id); return {}; },
    },
  };

  const res = await request(appAs('tpo_head'))
    .post('/api/institution/assessments')
    .set('Authorization', `Bearer ${tok('tpo_head')}`)
    .send({ cohortId: 'c1', type: 'mcq', title: 'MCQ Test' });

  // Route still returns 201 immediately (fire-and-forget)
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.success, true);

  // Give the microtask queue one tick to let the fire-and-forget run
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(authorMcqCalledWithId, 'a-mcq-1', 'authorMcq should be called with the new assessment id');
  assessments._deps = null;
});

test('POST /assessments (interview type) does NOT trigger authoringService.authorMcq', async () => {
  let authorMcqCalled = false;

  assessments._deps = {
    assessmentService: {
      createAssessment: async (scope, payload) => ({
        _id: 'a-iv-1',
        type: 'interview',
        ...scope,
        ...payload,
      }),
    },
    authoringService: {
      authorMcq: async () => { authorMcqCalled = true; return {}; },
    },
  };

  const res = await request(appAs('tpo_head'))
    .post('/api/institution/assessments')
    .set('Authorization', `Bearer ${tok('tpo_head')}`)
    .send({ cohortId: 'c1', type: 'interview', title: 'Interview Test' });

  assert.strictEqual(res.status, 201);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(authorMcqCalled, false, 'authorMcq must NOT be called for non-mcq type');
  assessments._deps = null;
});

// ── NO_QUESTIONS release gate ─────────────────────────────────────────────────

test('POST /assessments/:id/release → 409 NO_QUESTIONS when mcq has no questions yet', async () => {
  assessments._deps = {
    assessmentService: {
      releaseAssessment: async () => { throw new Error('NO_QUESTIONS'); },
    },
  };
  const res = await request(appAs('tpo_head'))
    .post('/api/institution/assessments/a1/release')
    .set('Authorization', `Bearer ${tok('tpo_head')}`);
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.code, 'NO_QUESTIONS');
  assert.ok(res.body.message, 'message should be present');
  assessments._deps = null;
});

// ── Capstone authoring trigger ─────────────────────────────────────────────────

test('POST /assessments (capstone type) triggers authoringService.authorCapstone with assessment id', async () => {
  let authorCapstoneCalledWithId = null;

  assessments._deps = {
    assessmentService: {
      createAssessment: async (scope, payload) => ({
        _id: 'a-cap-1',
        type: 'capstone',
        ...scope,
        ...payload,
      }),
    },
    authoringService: {
      authorMcq: async () => {},
      authorCapstone: async (id) => { authorCapstoneCalledWithId = String(id); return {}; },
    },
  };

  const res = await request(appAs('tpo_head'))
    .post('/api/institution/assessments')
    .set('Authorization', `Bearer ${tok('tpo_head')}`)
    .send({ cohortId: 'c1', type: 'capstone', title: 'Capstone Test' });

  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.success, true);

  await new Promise((r) => setImmediate(r));
  assert.strictEqual(authorCapstoneCalledWithId, 'a-cap-1', 'authorCapstone should be called with the new assessment id');
  assessments._deps = null;
});

test('POST /assessments (capstone type) does NOT trigger authoringService.authorMcq', async () => {
  let authorMcqCalled = false;

  assessments._deps = {
    assessmentService: {
      createAssessment: async (scope, payload) => ({
        _id: 'a-cap-2',
        type: 'capstone',
        ...scope,
        ...payload,
      }),
    },
    authoringService: {
      authorMcq: async () => { authorMcqCalled = true; return {}; },
      authorCapstone: async () => {},
    },
  };

  const res = await request(appAs('tpo_head'))
    .post('/api/institution/assessments')
    .set('Authorization', `Bearer ${tok('tpo_head')}`)
    .send({ cohortId: 'c1', type: 'capstone', title: 'Capstone Test 2' });

  assert.strictEqual(res.status, 201);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(authorMcqCalled, false, 'authorMcq must NOT be called for capstone type');
  assessments._deps = null;
});

test('POST /assessments (mcq type) does NOT trigger authoringService.authorCapstone', async () => {
  let authorCapstoneCalled = false;

  assessments._deps = {
    assessmentService: {
      createAssessment: async (scope, payload) => ({
        _id: 'a-mcq-2',
        type: 'mcq',
        ...scope,
        ...payload,
      }),
    },
    authoringService: {
      authorMcq: async () => {},
      authorCapstone: async () => { authorCapstoneCalled = true; return {}; },
    },
  };

  const res = await request(appAs('tpo_head'))
    .post('/api/institution/assessments')
    .set('Authorization', `Bearer ${tok('tpo_head')}`)
    .send({ cohortId: 'c1', type: 'mcq', title: 'MCQ Test 2' });

  assert.strictEqual(res.status, 201);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(authorCapstoneCalled, false, 'authorCapstone must NOT be called for mcq type');
  assessments._deps = null;
});

// ── NO_BUNDLE release gate ─────────────────────────────────────────────────────

test('POST /assessments/:id/release → 409 NO_BUNDLE when capstone has no bundleId', async () => {
  assessments._deps = {
    assessmentService: {
      releaseAssessment: async () => { throw new Error('NO_BUNDLE'); },
    },
  };
  const res = await request(appAs('tpo_head'))
    .post('/api/institution/assessments/a1/release')
    .set('Authorization', `Bearer ${tok('tpo_head')}`);
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.code, 'NO_BUNDLE');
  assert.ok(res.body.message, 'message should be present');
  assessments._deps = null;
});

test('POST /assessments/:id/release → 200 when capstone has bundleId (NO_BUNDLE not thrown)', async () => {
  const fakeReleasedAt = new Date();
  assessments._deps = {
    assessmentService: {
      releaseAssessment: async () => ({ _id: 'a-cap-ok', status: 'released', releasedAt: fakeReleasedAt }),
    },
  };
  const res = await request(appAs('tpo_head'))
    .post('/api/institution/assessments/a-cap-ok/release')
    .set('Authorization', `Bearer ${tok('tpo_head')}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.data.status, 'released');
  assessments._deps = null;
});

// ── Close action (Sub-feature C) ─────────────────────────────────────────────

test('POST /assessments/:id/close → 200 with {id, status, closedAt}', async () => {
  const fakeClosedAt = new Date('2026-06-23T12:00:00Z');
  assessments._deps = {
    assessmentService: {
      closeAssessment: async (scope, id, by) => ({
        _id: 'a1', status: 'closed', closedAt: fakeClosedAt,
      }),
    },
  };
  const res = await request(appAs('tpo_head'))
    .post('/api/institution/assessments/a1/close')
    .set('Authorization', `Bearer ${tok('tpo_head')}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.data.status, 'closed');
  assert.ok(res.body.data.closedAt, 'closedAt should be in response');
  assert.ok(res.body.data.id, 'id should be in response');
  assessments._deps = null;
});

test('tpo_coordinator POST /assessments/:id/close → 403 (role gate)', async () => {
  const res = await request(appAs('tpo_coordinator'))
    .post('/api/institution/assessments/a1/close')
    .set('Authorization', `Bearer ${tok('tpo_coordinator')}`);
  assert.strictEqual(res.status, 403);
});

test('institution_admin POST /assessments/:id/close → 200', async () => {
  const fakeClosedAt = new Date();
  assessments._deps = {
    assessmentService: {
      closeAssessment: async () => ({ _id: 'a1', status: 'closed', closedAt: fakeClosedAt }),
    },
  };
  const res = await request(appAs('institution_admin'))
    .post('/api/institution/assessments/a1/close')
    .set('Authorization', `Bearer ${tok('institution_admin')}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.status, 'closed');
  assessments._deps = null;
});

test('POST /assessments/:id/close → 404 when NOT_FOUND thrown', async () => {
  assessments._deps = {
    assessmentService: {
      closeAssessment: async () => { throw new Error('NOT_FOUND'); },
    },
  };
  const res = await request(appAs('tpo_head'))
    .post('/api/institution/assessments/a1/close')
    .set('Authorization', `Bearer ${tok('tpo_head')}`);
  assert.strictEqual(res.status, 404);
  assessments._deps = null;
});

// ── Re-author endpoints (Sub-feature D) ──────────────────────────────────────

test('POST /assessments/:id/author-mcq → 202 {status:authoring}', async () => {
  let authorMcqCalledWithId = null;
  assessments._deps = {
    Assessment: {
      findOne: async () => ({ _id: 'a1' }),
    },
    authoringService: {
      authorMcq: async (id) => { authorMcqCalledWithId = String(id); return {}; },
    },
  };
  const res = await request(appAs('tpo_head'))
    .post('/api/institution/assessments/a1/author-mcq')
    .set('Authorization', `Bearer ${tok('tpo_head')}`);
  assert.strictEqual(res.status, 202);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.data.status, 'authoring');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(authorMcqCalledWithId, 'a1', 'authorMcq should be called fire-and-forget');
  assessments._deps = null;
});

test('tpo_coordinator POST /assessments/:id/author-mcq → 202', async () => {
  assessments._deps = {
    Assessment: {
      findOne: async () => ({ _id: 'a1' }),
    },
    authoringService: {
      authorMcq: async () => ({}),
    },
  };
  const res = await request(appAs('tpo_coordinator'))
    .post('/api/institution/assessments/a1/author-mcq')
    .set('Authorization', `Bearer ${tok('tpo_coordinator')}`);
  assert.strictEqual(res.status, 202);
  assessments._deps = null;
});

test('viewer POST /assessments/:id/author-mcq → 403', async () => {
  const res = await request(appAs('viewer'))
    .post('/api/institution/assessments/a1/author-mcq')
    .set('Authorization', `Bearer ${tok('viewer')}`);
  assert.strictEqual(res.status, 403);
});

test('POST /assessments/:id/author-mcq → 404 when assessment not found', async () => {
  assessments._deps = {
    Assessment: {
      findOne: async () => null,
    },
    authoringService: {
      authorMcq: async () => ({}),
    },
  };
  const res = await request(appAs('tpo_head'))
    .post('/api/institution/assessments/missing/author-mcq')
    .set('Authorization', `Bearer ${tok('tpo_head')}`);
  assert.strictEqual(res.status, 404);
  assessments._deps = null;
});

test('POST /assessments/:id/author-capstone → 202 {status:authoring}', async () => {
  let authorCapstoneCalledWithId = null;
  assessments._deps = {
    Assessment: {
      findOne: async () => ({ _id: 'a-cap' }),
    },
    authoringService: {
      authorCapstone: async (id) => { authorCapstoneCalledWithId = String(id); return {}; },
    },
  };
  const res = await request(appAs('tpo_head'))
    .post('/api/institution/assessments/a-cap/author-capstone')
    .set('Authorization', `Bearer ${tok('tpo_head')}`);
  assert.strictEqual(res.status, 202);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.data.status, 'authoring');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(authorCapstoneCalledWithId, 'a-cap', 'authorCapstone should be called fire-and-forget');
  assessments._deps = null;
});

test('POST /assessments/:id/author-capstone → 404 when assessment not found', async () => {
  assessments._deps = {
    Assessment: {
      findOne: async () => null,
    },
    authoringService: {
      authorCapstone: async () => ({}),
    },
  };
  const res = await request(appAs('tpo_head'))
    .post('/api/institution/assessments/missing/author-capstone')
    .set('Authorization', `Bearer ${tok('tpo_head')}`);
  assert.strictEqual(res.status, 404);
  assessments._deps = null;
});

test('tpo_coordinator POST /assessments/:id/author-capstone → 202', async () => {
  let authorCalled = false;
  assessments._deps = {
    Assessment: {
      findOne: async () => ({ _id: 'a-cap-1' }),
    },
    authoringService: {
      authorCapstone: async () => { authorCalled = true; },
    },
  };
  const res = await request(appAs('tpo_coordinator'))
    .post('/api/institution/assessments/a-cap-1/author-capstone')
    .set('Authorization', `Bearer ${tok('tpo_coordinator')}`);
  assert.strictEqual(res.status, 202);
  assert.strictEqual(res.body.data.status, 'authoring');
  assessments._deps = null;
});

test('viewer POST /assessments/:id/author-capstone → 403 (role gate)', async () => {
  const res = await request(appAs('viewer'))
    .post('/api/institution/assessments/a-cap-1/author-capstone')
    .set('Authorization', `Bearer ${tok('viewer')}`);
  assert.strictEqual(res.status, 403);
});

// ── Create validation errors (Sub-feature E) ──────────────────────────────────

test('POST /assessments → 404 COHORT_NOT_FOUND when cohort validation fails', async () => {
  assessments._deps = {
    assessmentService: {
      createAssessment: async () => { throw new Error('COHORT_NOT_FOUND'); },
    },
  };
  const res = await request(appAs('tpo_head'))
    .post('/api/institution/assessments')
    .set('Authorization', `Bearer ${tok('tpo_head')}`)
    .send({ cohortId: 'c-missing', type: 'mcq', title: 'T' });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.code, 'COHORT_NOT_FOUND');
  assessments._deps = null;
});

test('POST /assessments → 400 BAD_CONFIG when interview missing interviewType', async () => {
  assessments._deps = {
    assessmentService: {
      createAssessment: async () => { throw new Error('BAD_CONFIG'); },
    },
  };
  const res = await request(appAs('tpo_head'))
    .post('/api/institution/assessments')
    .set('Authorization', `Bearer ${tok('tpo_head')}`)
    .send({ cohortId: 'c1', type: 'interview', title: 'T', config: { interview: {} } });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.code, 'BAD_CONFIG');
  assessments._deps = null;
});

test('POST /assessments → 400 BAD_CONFIG when capstone missing bundleId/roleTrack/jobDescription', async () => {
  assessments._deps = {
    assessmentService: {
      createAssessment: async () => { throw new Error('BAD_CONFIG'); },
    },
    authoringService: { authorCapstone: async () => {} },
  };
  const res = await request(appAs('tpo_head'))
    .post('/api/institution/assessments')
    .set('Authorization', `Bearer ${tok('tpo_head')}`)
    .send({ cohortId: 'c1', type: 'capstone', title: 'Bad Capstone' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.code, 'BAD_CONFIG');
  assessments._deps = null;
});

test('POST /assessments → 400 BAD_WINDOW when opensAt >= closesAt', async () => {
  assessments._deps = {
    assessmentService: {
      createAssessment: async () => { throw new Error('BAD_WINDOW'); },
    },
  };
  const res = await request(appAs('tpo_head'))
    .post('/api/institution/assessments')
    .set('Authorization', `Bearer ${tok('tpo_head')}`)
    .send({ cohortId: 'c1', type: 'mcq', title: 'T', opensAt: '2026-06-25T10:00:00Z', closesAt: '2026-06-25T10:00:00Z' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.code, 'BAD_WINDOW');
  assessments._deps = null;
});

// ── Monitor route — windowClosed triggered by status=closed (Sub-feature C) ──

test('GET /assessments/:id/sessions reveals score when assessment.status === \'closed\'', async () => {
  // assessment has status='closed' but NO closesAt — score should still be visible
  assessments._deps = {
    Assessment: {
      findOne: async () => ({
        _id: 'a1',
        institutionId: 'i1',
        cohortId: 'c1',
        status: 'closed',
        closesAt: undefined, // no closesAt set
      }),
    },
    AssessmentSession: {
      find: async () => [
        { _id: 's1', userId: 'u1', status: 'graded', result: { score: 95 } },
      ],
    },
    InstitutionEnrollment: { countDocuments: async () => 1, find: async () => [] },
    User: { find: async () => [] },
  };

  const res = await request(appAs('viewer'))
    .get('/api/institution/assessments/a1/sessions')
    .set('Authorization', `Bearer ${tok('viewer')}`);

  assert.strictEqual(res.status, 200);
  const { sessions } = res.body.data;
  assert.strictEqual(sessions[0].score, 95, 'score should be visible when assessment is closed');
  assessments._deps = null;
});

// ── TPO Granular Analytics tests (feat/2a) ────────────────────────────────────

// Monitor — name + rollNumber
test('GET /assessments/:id/sessions includes name and rollNumber from enrollment+user', async () => {
  const past = new Date(Date.now() - 86400000);
  assessments._deps = {
    Assessment: {
      findOne: async () => ({ _id: 'a1', institutionId: 'i1', cohortId: 'c1', closesAt: past }),
    },
    AssessmentSession: {
      find: async () => [{ _id: 's1', userId: 'u1', status: 'graded', result: { score: 88 } }],
    },
    InstitutionEnrollment: {
      countDocuments: async () => 1,
      find: async () => [{ userId: 'u1', rollNumber: '2021CS001' }],
    },
    User: {
      find: async () => [{ _id: 'u1', firstName: 'Priya', lastName: 'Sharma' }],
    },
  };

  const res = await request(appAs('viewer'))
    .get('/api/institution/assessments/a1/sessions')
    .set('Authorization', `Bearer ${tok('viewer')}`);

  assert.strictEqual(res.status, 200);
  const { sessions } = res.body.data;
  assert.strictEqual(sessions[0].name, 'Priya Sharma');
  assert.strictEqual(sessions[0].rollNumber, '2021CS001');
  assessments._deps = null;
});

// Per-student detail — happy path (window closed)
test('GET /assessments/:id/sessions/:userId returns full detail when window closed', async () => {
  const past = new Date(Date.now() - 86400000);
  assessments._deps = {
    Assessment: {
      findOne: async () => ({ _id: 'a1', institutionId: 'i1', cohortId: 'c1', closesAt: past }),
    },
    AssessmentSession: {
      findOne: async () => ({
        _id: 's1',
        userId: 'u1',
        status: 'graded',
        startedAt: new Date('2026-01-01T09:00:00Z'),
        submittedAt: new Date('2026-01-01T10:00:00Z'),
        gradedAt: new Date('2026-01-01T11:00:00Z'),
        result: { score: 77, integrity: 'clean', raw: { competencyBreakdown: [] } },
      }),
    },
    InstitutionEnrollment: {
      findOne: async () => ({ rollNumber: '2021CS042', cohortId: 'c1', userId: 'u1' }),
    },
    User: {
      findOne: async () => ({ _id: 'u1', firstName: 'Priya', lastName: 'Sharma' }),
    },
  };

  const res = await request(appAs('viewer'))
    .get('/api/institution/assessments/a1/sessions/u1')
    .set('Authorization', `Bearer ${tok('viewer')}`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.data.score, 77);
  assert.strictEqual(res.body.data.integrity, 'clean');
  assert.ok(res.body.data.raw, 'raw should be present');
  assert.strictEqual(res.body.data.name, 'Priya Sharma');
  assert.strictEqual(res.body.data.rollNumber, '2021CS042');
  assessments._deps = null;
});

// Per-student detail — score hidden when window open
test('GET /assessments/:id/sessions/:userId hides score while window open', async () => {
  const future = new Date(Date.now() + 86400000);
  assessments._deps = {
    Assessment: {
      findOne: async () => ({ _id: 'a1', institutionId: 'i1', cohortId: 'c1', closesAt: future }),
    },
    AssessmentSession: {
      findOne: async () => ({
        _id: 's1',
        userId: 'u1',
        status: 'graded',
        startedAt: null,
        submittedAt: null,
        gradedAt: null,
        result: { score: 77, integrity: 'clean', raw: null },
      }),
    },
    InstitutionEnrollment: { findOne: async () => null },
    User: { findOne: async () => null },
  };

  const res = await request(appAs('viewer'))
    .get('/api/institution/assessments/a1/sessions/u1')
    .set('Authorization', `Bearer ${tok('viewer')}`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.score, undefined, 'score key must be absent while window is open');
  assessments._deps = null;
});

// Per-student detail — 404 when no session
test('GET /assessments/:id/sessions/:userId → 404 when session not found', async () => {
  assessments._deps = {
    Assessment: {
      findOne: async () => ({ _id: 'a1', institutionId: 'i1', cohortId: 'c1' }),
    },
    AssessmentSession: {
      findOne: async () => null,
    },
  };

  const res = await request(appAs('viewer'))
    .get('/api/institution/assessments/a1/sessions/u-missing')
    .set('Authorization', `Bearer ${tok('viewer')}`);

  assert.strictEqual(res.status, 404);
  assessments._deps = null;
});

// Per-student detail — 404 when assessment not found
test('GET /assessments/:id/sessions/:userId → 404 when assessment not found', async () => {
  assessments._deps = {
    Assessment: { findOne: async () => null },
    AssessmentSession: { findOne: async () => null },
  };

  const res = await request(appAs('viewer'))
    .get('/api/institution/assessments/missing/sessions/u1')
    .set('Authorization', `Bearer ${tok('viewer')}`);

  assert.strictEqual(res.status, 404);
  assessments._deps = null;
});

// CSV export — 200 text/csv with correct columns
test('GET /assessments/:id/export.csv → 200 text/csv with correct columns', async () => {
  const past = new Date(Date.now() - 86400000);
  const fakeRows = [{
    userId: 'u1',
    name: 'Priya Sharma',
    rollNumber: '2021CS001',
    status: 'graded',
    score: 88,
    integrity: 'clean',
    submittedAt: new Date('2026-01-01T10:00:00Z'),
    gradedAt: new Date('2026-01-02T10:00:00Z'),
    raw: null,
  }];

  assessments._deps = {
    Assessment: {
      findOne: async () => ({ _id: 'a1', institutionId: 'i1', cohortId: 'c1', closesAt: past, title: 'Round 1' }),
    },
    CohortRollup: {
      findOne: () => ({
        lean: async () => ({ byCompetency: [{ name: 'Algorithms', avgScore: 70 }] }),
      }),
    },
    reportService: {
      buildSessionRows: async () => fakeRows,
      toCsv: (rows, cols) => {
        const { toCsv: realToCsv } = require('../../services/institution/assessment/assessmentReportService');
        return realToCsv(rows, cols);
      },
    },
  };

  const res = await request(appAs('viewer'))
    .get('/api/institution/assessments/a1/export.csv')
    .set('Authorization', `Bearer ${tok('viewer')}`);

  assert.strictEqual(res.status, 200);
  assert.ok(res.headers['content-type'].includes('text/csv'), 'content-type should include text/csv');
  assert.ok(res.text.includes('rollNumber,name,status,score'), 'header row should be present');
  assert.ok(res.text.includes('2021CS001'), 'roll number should appear in CSV');
  // Fixture uses comma-free values (name='Priya Sharma', rollNumber='2021CS001') so
  // positional split by ',' is safe here.
  const linesOpen = res.text.split('\n');
  const dataRowOpen = linesOpen[1];
  const colsOpen = dataRowOpen.split(',');
  assert.strictEqual(colsOpen[3], '88', 'score column should be present when window is closed');
  assessments._deps = null;
});

// CSV export — score blank when window not closed
test('GET /assessments/:id/export.csv → score column blank when window not closed', async () => {
  const future = new Date(Date.now() + 86400000);
  const fakeRows = [{
    userId: 'u1',
    name: 'Priya Sharma',
    rollNumber: '2021CS001',
    status: 'graded',
    score: null, // null because revealScores=false
    integrity: 'clean',
    submittedAt: null,
    gradedAt: null,
    raw: null,
  }];

  assessments._deps = {
    Assessment: {
      findOne: async () => ({ _id: 'a1', institutionId: 'i1', cohortId: 'c1', closesAt: future, title: 'Round 1' }),
    },
    CohortRollup: {
      findOne: () => ({ lean: async () => null }),
    },
    reportService: {
      buildSessionRows: async () => fakeRows,
      toCsv: (rows, cols) => {
        const { toCsv: realToCsv } = require('../../services/institution/assessment/assessmentReportService');
        return realToCsv(rows, cols);
      },
    },
  };

  const res = await request(appAs('viewer'))
    .get('/api/institution/assessments/a1/export.csv')
    .set('Authorization', `Bearer ${tok('viewer')}`);

  assert.strictEqual(res.status, 200);
  // Fixture uses comma-free values (name='Priya Sharma', rollNumber='2021CS001',
  // integrity='clean') so positional split by ',' is safe here.
  const lines = res.text.split('\n');
  const dataRow = lines[1]; // first data row (after header)
  const cols = dataRow.split(',');
  assert.strictEqual(cols[3], '', 'score column should be blank when window not closed');
  assessments._deps = null;
});

// ── Feature 4: GET /cohorts/:cohortId/assessment-suggestions ─────────────────

test('GET /cohorts/:cohortId/assessment-suggestions → 200 with suggestions (any role)', async () => {
  const fakeSuggestions = [
    { type: 'mcq', title: 'Algorithms — MCQ', cohortId: 'c1', config: { mcq: { topic: 'Algorithms', totalQuestions: 15, assessmentType: 'mixed' } }, reason: 'core MCQ' },
    { type: 'interview', title: 'HR Interview', cohortId: 'c1', config: { interview: { interviewType: 'placement_hr', difficulty: 'moderate' } }, reason: 'Placement readiness — behavioural round' },
  ];
  const fakeCohort = { _id: 'c1', institutionId: 'i1', objectiveTemplateId: 'tpl1' };
  const fakeTemplate = { _id: 'tpl1', capabilityTrack: 'software', competencies: [] };

  assessments._deps = {
    InstitutionCohort: {
      findOne: async (filter) => {
        assert.strictEqual(String(filter.institutionId), 'i1');
        assert.strictEqual(String(filter._id), 'c1');
        return fakeCohort;
      },
    },
    ObjectiveTemplate: {
      findOne: async () => fakeTemplate,
    },
    suggestionService: {
      buildSuggestions: (cohort, template) => {
        assert.ok(cohort, 'cohort should be passed');
        assert.ok(template, 'template should be passed');
        return { suggestions: fakeSuggestions };
      },
    },
  };

  const res = await request(appAs('viewer'))
    .get('/api/institution/cohorts/c1/assessment-suggestions')
    .set('Authorization', `Bearer ${tok('viewer')}`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.ok(Array.isArray(res.body.data.suggestions), 'suggestions should be an array');
  assert.strictEqual(res.body.data.suggestions.length, 2);
  assessments._deps = null;
});

test('GET /cohorts/:cohortId/assessment-suggestions → 404 when cohort not in scope', async () => {
  assessments._deps = {
    InstitutionCohort: {
      findOne: async () => null, // not found / not scoped
    },
    ObjectiveTemplate: { findOne: async () => null },
    suggestionService: { buildSuggestions: () => ({ suggestions: [] }) },
  };

  const res = await request(appAs('tpo_head'))
    .get('/api/institution/cohorts/c-evil/assessment-suggestions')
    .set('Authorization', `Bearer ${tok('tpo_head')}`);

  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.success, false);
  assessments._deps = null;
});

test('GET /cohorts/:cohortId/assessment-suggestions: no template → generic set with note', async () => {
  const fakeCohort = { _id: 'c2', institutionId: 'i1', objectiveTemplateId: null };

  assessments._deps = {
    InstitutionCohort: { findOne: async () => fakeCohort },
    ObjectiveTemplate: { findOne: async () => null },
    suggestionService: {
      buildSuggestions: (cohort, template) => {
        assert.strictEqual(template, null, 'template should be null when not linked');
        // Invoke real service to verify generic path
        const { buildSuggestions: real } = require('../../services/institution/assessment/assessmentSuggestionService');
        return real(cohort, null);
      },
    },
  };

  const res = await request(appAs('viewer'))
    .get('/api/institution/cohorts/c2/assessment-suggestions')
    .set('Authorization', `Bearer ${tok('viewer')}`);

  assert.strictEqual(res.status, 200);
  assert.ok(res.body.data.note, 'note should be present for generic set');
  assert.ok(res.body.data.suggestions.length >= 1, 'should have at least one generic suggestion');
  assessments._deps = null;
});

test('GET /cohorts/:cohortId/assessment-suggestions: LLM rankSuggestions reorders result', async () => {
  const original = [
    { type: 'mcq', title: 'Algo MCQ', cohortId: 'c3', config: {}, reason: 'reason1' },
    { type: 'capstone', title: 'Capstone', cohortId: 'c3', config: {}, reason: 'reason2' },
  ];
  const reordered = [
    { type: 'capstone', title: 'Capstone', cohortId: 'c3', config: {}, reason: 'LLM reason capstone' },
    { type: 'mcq', title: 'Algo MCQ', cohortId: 'c3', config: {}, reason: 'LLM reason mcq' },
  ];
  const fakeCohort = { _id: 'c3', institutionId: 'i1', objectiveTemplateId: null };

  assessments._deps = {
    InstitutionCohort: { findOne: async () => fakeCohort },
    ObjectiveTemplate: { findOne: async () => null },
    suggestionService: {
      buildSuggestions: () => ({ suggestions: original }),
      rankSuggestions: async () => reordered,
    },
    rankDeps: {},
  };

  const res = await request(appAs('viewer'))
    .get('/api/institution/cohorts/c3/assessment-suggestions')
    .set('Authorization', `Bearer ${tok('viewer')}`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.data.suggestions[0].type, 'capstone', 'LLM-reranked capstone is first');
  assert.strictEqual(res.body.data.suggestions[1].type, 'mcq');
  assessments._deps = null;
});

test('GET /cohorts/:cohortId/assessment-suggestions: LLM rankSuggestions throws → still returns 200 with rule-based order', async () => {
  const original = [
    { type: 'mcq', title: 'Algo MCQ', cohortId: 'c4', config: {}, reason: 'reason1' },
    { type: 'interview', title: 'HR Interview', cohortId: 'c4', config: {}, reason: 'reason2' },
  ];
  const fakeCohort = { _id: 'c4', institutionId: 'i1', objectiveTemplateId: null };

  assessments._deps = {
    InstitutionCohort: { findOne: async () => fakeCohort },
    ObjectiveTemplate: { findOne: async () => null },
    suggestionService: {
      buildSuggestions: () => ({ suggestions: original }),
      rankSuggestions: async () => { throw new Error('LLM_DOWN'); },
    },
    rankDeps: {},
  };

  const res = await request(appAs('viewer'))
    .get('/api/institution/cohorts/c4/assessment-suggestions')
    .set('Authorization', `Bearer ${tok('viewer')}`);

  assert.strictEqual(res.status, 200, 'route should succeed even when LLM throws');
  assert.strictEqual(res.body.success, true);
  // Rule-based order preserved
  assert.strictEqual(res.body.data.suggestions[0].type, 'mcq');
  assert.strictEqual(res.body.data.suggestions[1].type, 'interview');
  assessments._deps = null;
});

// ── Feature 5: GET /assessments/:id/preview ───────────────────────────────────

test('GET /assessments/:id/preview → 200 for mcq type with questions', async () => {
  const fakeQuestions = [
    { questionText: 'What is O(n)?', options: ['A', 'B', 'C', 'D'], correctAnswer: 'A', concept: 'complexity' },
    { questionText: 'Best sort for nearly sorted?', options: ['P', 'Q', 'R', 'S'], correctAnswer: 'P', concept: 'sorting' },
  ];
  assessments._deps = {
    Assessment: {
      findOne: async () => ({
        _id: 'a1',
        institutionId: 'i1',
        type: 'mcq',
        config: { mcq: { questions: fakeQuestions, totalQuestions: 2 } },
      }),
    },
    ArtifactBundle: { findOne: async () => null },
  };

  const res = await request(appAs('viewer'))
    .get('/api/institution/assessments/a1/preview')
    .set('Authorization', `Bearer ${tok('viewer')}`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  const d = res.body.data;
  assert.strictEqual(d.type, 'mcq');
  assert.strictEqual(d.ready, true);
  assert.strictEqual(d.questionCount, 2);
  assert.strictEqual(d.questions.length, 2);
  // TPO may review answers
  assert.strictEqual(d.questions[0].correctAnswer, 'A');
  assert.strictEqual(d.questions[0].questionText, 'What is O(n)?');
  assessments._deps = null;
});

test('GET /assessments/:id/preview → mcq with no questions: ready=false, questionCount=0', async () => {
  assessments._deps = {
    Assessment: {
      findOne: async () => ({
        _id: 'a-empty',
        institutionId: 'i1',
        type: 'mcq',
        config: { mcq: { questions: [] } },
      }),
    },
    ArtifactBundle: { findOne: async () => null },
  };

  const res = await request(appAs('tpo_head'))
    .get('/api/institution/assessments/a-empty/preview')
    .set('Authorization', `Bearer ${tok('tpo_head')}`);

  assert.strictEqual(res.status, 200);
  const d = res.body.data;
  assert.strictEqual(d.ready, false);
  assert.strictEqual(d.questionCount, 0);
  assessments._deps = null;
});

test('GET /assessments/:id/preview → capstone returns safeBundleView WITHOUT reference_solution/hidden_tests', async () => {
  const fakeBundle = {
    _id: 'bun1',
    brief: 'Build a REST API for a todo app.',
    acceptance_criteria: ['GET /todos returns list', 'POST /todos creates item'],
    visible_tests: [{ name: 'smoke test', command: 'npm test' }],
    difficulty: 'medium',
    time_budget_minutes: 90,
    role_track: 'swe',
    language: 'javascript',
    // These should NEVER appear in the preview response:
    reference_solution: { files: [{ path: 'src/app.js', content: 'SECRET' }] },
    hidden_tests: [{ name: 'hidden', command: 'npm run test:hidden', expected_exit_code: 0 }],
  };

  assessments._deps = {
    Assessment: {
      findOne: async () => ({
        _id: 'a-cap',
        institutionId: 'i1',
        type: 'capstone',
        config: { capstone: { bundleId: 'bun1', roleTrack: 'swe', difficulty: 'medium' } },
      }),
    },
    ArtifactBundle: { findOne: async () => fakeBundle },
  };

  const res = await request(appAs('tpo_head'))
    .get('/api/institution/assessments/a-cap/preview')
    .set('Authorization', `Bearer ${tok('tpo_head')}`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  const d = res.body.data;
  assert.strictEqual(d.type, 'capstone');
  assert.strictEqual(d.ready, true);
  assert.strictEqual(d.brief, 'Build a REST API for a todo app.');
  assert.ok(Array.isArray(d.acceptance_criteria), 'acceptance_criteria should be present');
  assert.ok(Array.isArray(d.visible_tests), 'visible_tests should be present');
  assert.strictEqual(d.difficulty, 'medium');
  assert.strictEqual(d.time_budget_minutes, 90);
  // CRITICAL: these must NEVER be present in the response
  assert.strictEqual(d.reference_solution, undefined, 'reference_solution MUST NOT be in preview response');
  assert.strictEqual(d.hidden_tests, undefined, 'hidden_tests MUST NOT be in preview response');
  assessments._deps = null;
});

test('GET /assessments/:id/preview → drill safeBundleView WITHOUT reference_solution/hidden_tests', async () => {
  const fakeDrillBundle = {
    _id: 'bun-drill',
    brief: 'Decompose this problem into functions.',
    acceptance_criteria: ['Function decomposed', 'Tests pass'],
    visible_tests: [{ name: 'test1', command: 'pytest' }],
    difficulty: 'medium',
    time_budget_minutes: 30,
    role_track: 'swe',
    language: 'python',
    reference_solution: { files: [{ path: 'solution.py', content: 'HIDDEN SOLUTION' }] },
    hidden_tests: [{ name: 'grader', command: 'pytest grader.py' }],
  };

  assessments._deps = {
    Assessment: {
      findOne: async () => ({
        _id: 'a-drill',
        institutionId: 'i1',
        type: 'drill',
        config: { drill: { bundleId: 'bun-drill', roleTrack: 'swe', drillSubtype: 'decompose' } },
      }),
    },
    ArtifactBundle: { findOne: async () => fakeDrillBundle },
  };

  const res = await request(appAs('viewer'))
    .get('/api/institution/assessments/a-drill/preview')
    .set('Authorization', `Bearer ${tok('viewer')}`);

  assert.strictEqual(res.status, 200);
  const d = res.body.data;
  assert.strictEqual(d.type, 'drill');
  assert.strictEqual(d.ready, true);
  assert.ok(d.brief, 'brief should be present');
  assert.strictEqual(d.reference_solution, undefined, 'reference_solution MUST NOT be in drill preview');
  assert.strictEqual(d.hidden_tests, undefined, 'hidden_tests MUST NOT be in drill preview');
  assessments._deps = null;
});

test('GET /assessments/:id/preview → capstone with no bundleId: ready=false', async () => {
  assessments._deps = {
    Assessment: {
      findOne: async () => ({
        _id: 'a-cap-no-bundle',
        institutionId: 'i1',
        type: 'capstone',
        config: { capstone: { roleTrack: 'swe', difficulty: 'medium' } }, // no bundleId
      }),
    },
    ArtifactBundle: { findOne: async () => null },
  };

  const res = await request(appAs('tpo_head'))
    .get('/api/institution/assessments/a-cap-no-bundle/preview')
    .set('Authorization', `Bearer ${tok('tpo_head')}`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.ready, false);
  assessments._deps = null;
});

test('GET /assessments/:id/preview → interview returns config (no content)', async () => {
  assessments._deps = {
    Assessment: {
      findOne: async () => ({
        _id: 'a-iv',
        institutionId: 'i1',
        type: 'interview',
        config: { interview: { interviewType: 'placement_hr', difficulty: 'moderate' } },
      }),
    },
    ArtifactBundle: { findOne: async () => null },
  };

  const res = await request(appAs('viewer'))
    .get('/api/institution/assessments/a-iv/preview')
    .set('Authorization', `Bearer ${tok('viewer')}`);

  assert.strictEqual(res.status, 200);
  const d = res.body.data;
  assert.strictEqual(d.type, 'interview');
  assert.strictEqual(d.ready, true);
  assert.strictEqual(d.config.interviewType, 'placement_hr');
  assessments._deps = null;
});

test('GET /assessments/:id/preview → 404 when assessment not in scope', async () => {
  assessments._deps = {
    Assessment: { findOne: async () => null },
    ArtifactBundle: { findOne: async () => null },
  };

  const res = await request(appAs('viewer'))
    .get('/api/institution/assessments/missing/preview')
    .set('Authorization', `Bearer ${tok('viewer')}`);

  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.success, false);
  assessments._deps = null;
});

// toCsv escaping unit tests (no HTTP)
test('toCsv escapes fields with commas and quotes', () => {
  const { toCsv } = require('../../services/institution/assessment/assessmentReportService');

  // Field with comma should be quoted
  const csv1 = toCsv([{
    rollNumber: '001',
    name: 'Smith, John',
    status: 'graded',
    score: 90,
    integrity: 'clean',
    submittedAt: null,
    gradedAt: null,
  }], []);
  assert.ok(csv1.includes('"Smith, John"'), `Expected name to be quoted; got: ${csv1}`);

  // Field with double-quote: internal quotes doubled
  const csv2 = toCsv([{
    rollNumber: '002',
    name: 'O\'Brien "Jr"',
    status: 'graded',
    score: null,
    integrity: null,
    submittedAt: null,
    gradedAt: null,
  }], []);
  assert.ok(csv2.includes('"O\'Brien ""Jr"""'), `Expected internal quotes doubled; got: ${csv2}`);
});

// ── I1: CSV formula-injection guard (escapeCsvField) ─────────────────────────

test('escapeCsvField prefixes formula-trigger chars with a single quote', () => {
  const { toCsv } = require('../../services/institution/assessment/assessmentReportService');

  // Helper: build a single-row CSV with a given name field and extract the name cell.
  function csvNameCell(name) {
    const csv = toCsv([{
      rollNumber: '001', name, status: 'graded', score: null,
      integrity: null, submittedAt: null, gradedAt: null, raw: null,
    }], []);
    // Second line, second cell (0-indexed: rollNumber,name,...)
    const cells = csv.split('\n')[1].split(',');
    return cells[1];
  }

  // =HYPERLINK(...) — formula trigger '='
  const hyperlink = csvNameCell('=HYPERLINK("http://evil.com","click")');
  assert.ok(hyperlink.startsWith("'=") || hyperlink.startsWith('"\'='),
    `=HYPERLINK name should be prefixed with quote; got: ${hyperlink}`);

  // +cmd — trigger '+'
  const plus = csvNameCell('+cmd|"/C calc"!A0');
  assert.ok(plus.startsWith("'+") || plus.startsWith('"\'+"') || plus.includes("'+"),
    `+cmd name should be prefixed with quote; got: ${plus}`);

  // @SUM — trigger '@'
  const at = csvNameCell('@SUM(A1)');
  assert.ok(at.startsWith("'@") || at.includes("'@"),
    `@SUM name should be prefixed with quote; got: ${at}`);

  // Normal name — no prefix added
  const normal = csvNameCell('Priya Sharma');
  assert.strictEqual(normal, 'Priya Sharma', 'normal name must not be prefixed');
});

// ── I2: Capstone competency scale (extractCompetencyValue) ───────────────────

test('extractCompetencyValue scales capstone dimension_scores x10 (7 → 70)', () => {
  const { extractCompetencyValue } = require('../../services/institution/assessment/assessmentReportService');

  const raw = { dimension_scores: { code_quality: 7, problem_solving: 5 } };
  assert.strictEqual(extractCompetencyValue(raw, 'code_quality'), 70,
    'capstone dimension 7 should export as 70 (scaled 0-10 → 0-100)');
  assert.strictEqual(extractCompetencyValue(raw, 'problem_solving'), 50,
    'capstone dimension 5 should export as 50');

  // Edge cases
  assert.strictEqual(extractCompetencyValue(raw, 'missing_dim'), '',
    'missing dimension should return empty string');
  assert.strictEqual(extractCompetencyValue(null, 'code_quality'), '',
    'null raw should return empty string');
});
