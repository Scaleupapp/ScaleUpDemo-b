'use strict';
/**
 * Tests for src/routes/institution/studentAssessments.js
 *
 * Auth strategy: inject a tiny stub middleware via router._deps.auth that just
 * sets req.user = { userId: STUDENT_ID } — avoids the real auth DB hit.
 *
 * Service strategy: inject all deps via router._deps so no real DB or engine calls.
 */
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

const studentAssessments = require('../../routes/institution/studentAssessments');

const STUDENT_ID = '507f1f77bcf86cd799439001';
const OTHER_ID   = '507f1f77bcf86cd799439099';

// Stub auth: sets req.user, no DB
const stubAuth = (userId) => (req, _res, next) => { req.user = { userId }; next(); };

function makeApp(depsOverrides) {
  studentAssessments._deps = depsOverrides;
  const a = express();
  a.use(express.json());
  a.use('/api/v2/me', studentAssessments);
  return a;
}

// ── GET /assessments ─────────────────────────────────────────────────────────

test('GET /assessments returns only released assessments scoped to student enrollment cohorts', async () => {
  const cohortId = '507f1f77bcf86cd799439010';
  const assessmentId = '507f1f77bcf86cd799439020';

  const app = makeApp({
    auth: stubAuth(STUDENT_ID),
    InstitutionEnrollment: {
      find: async (filter) => {
        assert.strictEqual(String(filter.userId), STUDENT_ID);
        return [{ cohortId }];
      },
    },
    Assessment: {
      find: async (filter) => {
        assert.strictEqual(filter.status, 'released');
        assert.ok(filter.cohortId.$in);
        return [{ _id: assessmentId, cohortId, status: 'released', title: 'Round 1' }];
      },
    },
    AssessmentSession: {
      find: async (filter) => {
        assert.strictEqual(String(filter.userId), STUDENT_ID);
        return [];
      },
    },
  });

  const res = await request(app)
    .get('/api/v2/me/assessments');

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.data.length, 1);
  assert.strictEqual(res.body.data[0].assessment.title, 'Round 1');
  assert.strictEqual(res.body.data[0].session, null); // no session yet
  studentAssessments._deps = null;
});

test('GET /assessments left-joins existing session for the student', async () => {
  const cohortId = '507f1f77bcf86cd799439010';
  const assessmentId = '507f1f77bcf86cd799439020';
  const sessionId  = '507f1f77bcf86cd799439030';

  const app = makeApp({
    auth: stubAuth(STUDENT_ID),
    InstitutionEnrollment: { find: async () => [{ cohortId }] },
    Assessment: { find: async () => [{ _id: assessmentId, cohortId, status: 'released', title: 'R2' }] },
    AssessmentSession: {
      find: async () => [{
        _id: sessionId,
        assessmentId,
        userId: STUDENT_ID,
        status: 'in_progress',
      }],
    },
  });

  const res = await request(app).get('/api/v2/me/assessments');
  assert.strictEqual(res.status, 200);
  const item = res.body.data[0];
  assert.ok(item.session, 'session should be populated');
  assert.strictEqual(item.session.status, 'in_progress');
  studentAssessments._deps = null;
});

test('GET /assessments returns empty array when student has no enrollments', async () => {
  const app = makeApp({
    auth: stubAuth(STUDENT_ID),
    InstitutionEnrollment: { find: async () => [] },
    Assessment: { find: async () => { throw new Error('Should not be called'); } },
    AssessmentSession: { find: async () => [] },
  });

  const res = await request(app).get('/api/v2/me/assessments');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.data, []);
  studentAssessments._deps = null;
});

// ── POST /assessments/:id/start ──────────────────────────────────────────────

test('POST /assessments/:id/start happy path → 201 with assessmentSessionId + engine', async () => {
  const sessionId = '507f1f77bcf86cd799439030';
  const app = makeApp({
    auth: stubAuth(STUDENT_ID),
    assessmentSessionService: {
      startSession: async (userId, assessmentId) => ({
        _id: sessionId,
        userId,
        assessmentId,
        engine: { type: 'mcq', quizId: 'q1', sessionId: 'att1' },
        status: 'in_progress',
      }),
    },
    // Stub getAdapter to return a mcq-like adapter with getStartMeta
    getAdapter: (type) => ({
      getStartMeta: async () => ({}),
    }),
  });

  const res = await request(app)
    .post('/api/v2/me/assessments/a1/start');

  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.data.assessmentSessionId, String(sessionId));
  assert.strictEqual(res.body.data.engine.type, 'mcq');
  assert.ok('meta' in res.body.data, 'meta key must be present in response');
  studentAssessments._deps = null;
});

test('POST /assessments/:id/start interview → 201 includes data.meta.systemInstruction', async () => {
  const sessionId = '507f1f77bcf86cd799439031';
  const app = makeApp({
    auth: stubAuth(STUDENT_ID),
    assessmentSessionService: {
      startSession: async (userId, assessmentId) => ({
        _id: sessionId,
        userId,
        assessmentId,
        engine: { type: 'interview', sessionId: 'ivSess1' },
        status: 'in_progress',
      }),
    },
    // Stub getAdapter to simulate interview adapter with persisted systemInstruction
    getAdapter: (type) => ({
      getStartMeta: async (session) => ({
        systemInstruction: 'You are a strict interviewer focused on React.',
      }),
    }),
  });

  const res = await request(app).post('/api/v2/me/assessments/a1/start');

  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.success, true);
  assert.ok(res.body.data.meta, 'meta must be present');
  assert.strictEqual(
    res.body.data.meta.systemInstruction,
    'You are a strict interviewer focused on React.',
    'systemInstruction must be passed through from engine meta'
  );
  studentAssessments._deps = null;
});

test('POST /assessments/:id/start → 201 even when getStartMeta throws (best-effort)', async () => {
  const sessionId = '507f1f77bcf86cd799439032';
  const app = makeApp({
    auth: stubAuth(STUDENT_ID),
    assessmentSessionService: {
      startSession: async () => ({
        _id: sessionId,
        userId: STUDENT_ID,
        assessmentId: 'a1',
        engine: { type: 'interview', sessionId: 'ivSess1' },
        status: 'in_progress',
      }),
    },
    getAdapter: () => ({
      getStartMeta: async () => { throw new Error('META_LOOKUP_FAILED'); },
    }),
  });

  const res = await request(app).post('/api/v2/me/assessments/a1/start');
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.success, true);
  // meta falls back to {}
  assert.deepStrictEqual(res.body.data.meta, {});
  studentAssessments._deps = null;
});

test('POST /assessments/:id/start NOT_ENROLLED → 403', async () => {
  const app = makeApp({
    auth: stubAuth(STUDENT_ID),
    assessmentSessionService: {
      startSession: async () => { throw new Error('NOT_ENROLLED'); },
    },
  });

  const res = await request(app).post('/api/v2/me/assessments/a1/start');
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.code, 'NOT_ENROLLED');
  studentAssessments._deps = null;
});

test('POST /assessments/:id/start CLOSED → 409', async () => {
  const app = makeApp({
    auth: stubAuth(STUDENT_ID),
    assessmentSessionService: {
      startSession: async () => { throw new Error('CLOSED'); },
    },
  });

  const res = await request(app).post('/api/v2/me/assessments/a1/start');
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.code, 'CLOSED');
  studentAssessments._deps = null;
});

test('POST /assessments/:id/start NOT_RELEASED → 409', async () => {
  const app = makeApp({
    auth: stubAuth(STUDENT_ID),
    assessmentSessionService: {
      startSession: async () => { throw new Error('NOT_RELEASED'); },
    },
  });

  const res = await request(app).post('/api/v2/me/assessments/a1/start');
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.code, 'NOT_RELEASED');
  studentAssessments._deps = null;
});

test('POST /assessments/:id/start NOT_FOUND → 404', async () => {
  const app = makeApp({
    auth: stubAuth(STUDENT_ID),
    assessmentSessionService: {
      startSession: async () => { throw new Error('NOT_FOUND'); },
    },
  });

  const res = await request(app).post('/api/v2/me/assessments/a1/start');
  assert.strictEqual(res.status, 404);
  studentAssessments._deps = null;
});

test('POST /assessments/:id/start unexpected error → 500 (no raw message leak)', async () => {
  const app = makeApp({
    auth: stubAuth(STUDENT_ID),
    assessmentSessionService: {
      startSession: async () => { throw new Error('DB_EXPLOSION_SECRET_STUFF'); },
    },
  });

  const res = await request(app).post('/api/v2/me/assessments/a1/start');
  assert.strictEqual(res.status, 500);
  // Raw error message must NOT be exposed to clients
  assert.ok(!JSON.stringify(res.body).includes('DB_EXPLOSION_SECRET_STUFF'));
  studentAssessments._deps = null;
});

// ── POST /assessments/sessions/:sessionId/sync ───────────────────────────────

test('POST /assessments/sessions/:sessionId/sync happy path → 200 with status + result', async () => {
  const app = makeApp({
    auth: stubAuth(STUDENT_ID),
    assessmentSessionService: {
      syncSession: async (sessionId) => ({
        _id: sessionId,
        userId: STUDENT_ID,
        status: 'graded',
        result: { score: 78 },
      }),
    },
  });

  const res = await request(app).post('/api/v2/me/assessments/sessions/sess1/sync');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.data.status, 'graded');
  assert.strictEqual(res.body.data.result.score, 78);
  studentAssessments._deps = null;
});

test('POST sync returns 404 if session belongs to different user', async () => {
  const app = makeApp({
    auth: stubAuth(STUDENT_ID),
    assessmentSessionService: {
      syncSession: async () => ({
        _id: 'sess1',
        userId: OTHER_ID, // different user!
        status: 'in_progress',
        result: null,
      }),
    },
  });

  const res = await request(app).post('/api/v2/me/assessments/sessions/sess1/sync');
  assert.strictEqual(res.status, 404);
  studentAssessments._deps = null;
});

test('POST sync NOT_FOUND → 404', async () => {
  const app = makeApp({
    auth: stubAuth(STUDENT_ID),
    assessmentSessionService: {
      syncSession: async () => { throw new Error('NOT_FOUND'); },
    },
  });

  const res = await request(app).post('/api/v2/me/assessments/sessions/sess1/sync');
  assert.strictEqual(res.status, 404);
  studentAssessments._deps = null;
});

// ── POST /assessments/sessions/:id/integrity (Wave 3 block 4) ─────────────────

function makeIntegritySession(overrides = {}) {
  return {
    _id: 'sess1',
    userId: STUDENT_ID,
    status: 'in_progress',
    save: async function () { return this; },
    ...overrides,
  };
}

test('POST integrity: clamps counters, flags on paste, stores + 200', async () => {
  let saved = null;
  const session = makeIntegritySession();
  session.save = async function () { saved = this.integritySignals; return this; };
  const app = makeApp({
    auth: stubAuth(STUDENT_ID),
    AssessmentSession: { findById: async () => session },
  });
  const res = await request(app)
    .post('/api/v2/me/assessments/sessions/sess1/integrity')
    .send({ appBackgroundedCount: 2, focusLossSeconds: 5, pasteCount: 1, extraIgnored: 9 });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.integritySignals.pasteCount, 1);
  assert.strictEqual(res.body.data.integritySignals.flagged, true, 'any paste flags');
  assert.ok(saved && saved.updatedAt, 'stored with updatedAt');
  studentAssessments._deps = null;
});

test('POST integrity: >3 backgroundings flags; clean stays unflagged; negatives clamp to 0', async () => {
  const app1 = makeApp({ auth: stubAuth(STUDENT_ID), AssessmentSession: { findById: async () => makeIntegritySession() } });
  const flagged = await request(app1)
    .post('/api/v2/me/assessments/sessions/sess1/integrity')
    .send({ appBackgroundedCount: 4, pasteCount: 0 });
  assert.strictEqual(flagged.body.data.integritySignals.flagged, true, '>3 backgroundings flags');
  studentAssessments._deps = null;

  const app2 = makeApp({ auth: stubAuth(STUDENT_ID), AssessmentSession: { findById: async () => makeIntegritySession() } });
  const clean = await request(app2)
    .post('/api/v2/me/assessments/sessions/sess1/integrity')
    .send({ appBackgroundedCount: 2, focusLossSeconds: -50, pasteCount: 0 });
  assert.strictEqual(clean.body.data.integritySignals.flagged, false, '≤3 backgroundings, no paste = clean');
  assert.strictEqual(clean.body.data.integritySignals.focusLossSeconds, 0, 'negative clamped to 0');
  studentAssessments._deps = null;
});

test('POST integrity: not the owner → 404', async () => {
  const app = makeApp({
    auth: stubAuth(STUDENT_ID),
    AssessmentSession: { findById: async () => makeIntegritySession({ userId: OTHER_ID }) },
  });
  const res = await request(app)
    .post('/api/v2/me/assessments/sessions/sess1/integrity')
    .send({ pasteCount: 1 });
  assert.strictEqual(res.status, 404);
  studentAssessments._deps = null;
});

test('POST integrity: session not in_progress → 409 NOT_IN_PROGRESS', async () => {
  const app = makeApp({
    auth: stubAuth(STUDENT_ID),
    AssessmentSession: { findById: async () => makeIntegritySession({ status: 'graded' }) },
  });
  const res = await request(app)
    .post('/api/v2/me/assessments/sessions/sess1/integrity')
    .send({ pasteCount: 1 });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.code, 'NOT_IN_PROGRESS');
  studentAssessments._deps = null;
});

test('POST integrity: non-numeric counter → 400 VALIDATION', async () => {
  const app = makeApp({
    auth: stubAuth(STUDENT_ID),
    AssessmentSession: { findById: async () => makeIntegritySession() },
  });
  const res = await request(app)
    .post('/api/v2/me/assessments/sessions/sess1/integrity')
    .send({ pasteCount: 'lots' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.code, 'VALIDATION');
  studentAssessments._deps = null;
});
