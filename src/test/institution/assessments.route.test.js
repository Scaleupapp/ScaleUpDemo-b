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
        closesAt: future,
      }),
    },
    AssessmentSession: {
      find: async () => [
        { _id: 's1', userId: 'u1', status: 'graded',      result: { score: 92 } },
        { _id: 's2', userId: 'u2', status: 'in_progress', result: null },
      ],
    },
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
        closesAt: past,
      }),
    },
    AssessmentSession: {
      find: async () => [
        { _id: 's1', userId: 'u1', status: 'graded', result: { score: 88 } },
      ],
    },
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
