'use strict';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');
const { signInstitutionToken } = require('../../services/institution/institutionAuthService');
const institutionAuth = require('../../middleware/institutionAuth');

// Stub _loadUser so no DB hit is needed in route-level tests
function stubLoadUser(institutionId, role) {
  institutionAuth._loadUser = async () => ({
    _id: 'u1',
    institutionId,
    role,
    status: 'active',
    tokenVersion: 0,
    scope: {},
  });
}

// Require rosters router AFTER setting up the stub environment
const rosters = require('../../routes/institution/rosters');

function appAs(institutionId, role) {
  stubLoadUser(institutionId, role);
  const a = express();
  a.use(express.json());
  a.use('/api/institution', rosters);
  return a;
}

function tok(institutionId, role) {
  return signInstitutionToken({ _id: 'u1', institutionId, role, tokenVersion: 0 });
}

// ── Funnel endpoint tests ────────────────────────────────────────────────────

test('funnel returns 200 with correct shape and counts for tpo_head', async () => {
  // Record which filters the count methods were called with
  const recordedFilters = {
    pendingStudentFilters: [],
    enrollmentFilters: [],
  };

  // Stub the models with fake count methods that record their filters
  rosters._deps = {
    PendingStudent: {
      countDocuments: async function(filter) {
        recordedFilters.pendingStudentFilters.push(filter);
        return 10; // invited count
      },
    },
    InstitutionEnrollment: {
      countDocuments: async function(filter) {
        recordedFilters.enrollmentFilters.push(filter);
        // Simulate different counts for different calls
        if (filter.status === 'registered') return 8;
        if (filter.status === 'diagnostic_done') return 5;
        if (filter.status === 'active') return 3;
        return 0;
      },
    },
  };

  try {
    const institutionId = 'iA';
    const cohortId = 'c123';
    stubLoadUser(institutionId, 'tpo_head');
    const a = express();
    a.use(express.json());
    a.use('/api/institution', rosters);

    const res = await request(a)
      .get(`/api/institution/cohorts/${cohortId}/funnel`)
      .set('Authorization', `Bearer ${tok(institutionId, 'tpo_head')}`);

    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.success, 'Response should have success: true');
    assert.ok(res.body.data, 'Response should have data');
    assert.strictEqual(res.body.data.invited, 10, 'invited count should be 10');
    assert.strictEqual(res.body.data.registered, 8, 'registered count should be 8');
    assert.strictEqual(res.body.data.diagnosticDone, 5, 'diagnosticDone count should be 5');
    assert.strictEqual(res.body.data.active, 3, 'active count should be 3');

    // Verify the counts were called with correct institutionId from token
    assert.ok(
      recordedFilters.pendingStudentFilters.length > 0,
      'PendingStudent.countDocuments should have been called'
    );
    assert.ok(
      recordedFilters.enrollmentFilters.length > 0,
      'InstitutionEnrollment.countDocuments should have been called'
    );

    // Check that all filters included the token's institutionId
    recordedFilters.pendingStudentFilters.forEach((filter, i) => {
      assert.strictEqual(
        filter.institutionId,
        institutionId,
        `PendingStudent filter ${i} should have institutionId=${institutionId}`
      );
      assert.strictEqual(
        filter.cohortId,
        cohortId,
        `PendingStudent filter ${i} should have cohortId=${cohortId}`
      );
    });

    recordedFilters.enrollmentFilters.forEach((filter, i) => {
      assert.strictEqual(
        filter.institutionId,
        institutionId,
        `InstitutionEnrollment filter ${i} should have institutionId=${institutionId}`
      );
      assert.strictEqual(
        filter.cohortId,
        cohortId,
        `InstitutionEnrollment filter ${i} should have cohortId=${cohortId}`
      );
    });
  } finally {
    rosters._deps = null;
  }
});

test('funnel isolation guard: token institutionId is used, not path/body institutionId', async () => {
  const recordedFilters = {
    pendingStudentFilters: [],
    enrollmentFilters: [],
  };

  rosters._deps = {
    PendingStudent: {
      countDocuments: async function(filter) {
        recordedFilters.pendingStudentFilters.push(filter);
        return 5;
      },
    },
    InstitutionEnrollment: {
      countDocuments: async function(filter) {
        recordedFilters.enrollmentFilters.push(filter);
        if (filter.status === 'registered') return 3;
        if (filter.status === 'diagnostic_done') return 2;
        if (filter.status === 'active') return 1;
        return 0;
      },
    },
  };

  try {
    // Token institutionId is 'iA'
    const tokenInstitutionId = 'iA';
    // But we try to pass a different institutionId in the body (should be ignored)
    const bodyCohortId = 'c123';

    stubLoadUser(tokenInstitutionId, 'tpo_head');
    const a = express();
    a.use(express.json());
    a.use('/api/institution', rosters);

    const res = await request(a)
      .get(`/api/institution/cohorts/${bodyCohortId}/funnel`)
      .set('Authorization', `Bearer ${tok(tokenInstitutionId, 'tpo_head')}`)
      .send({ institutionId: 'iB' }); // Try to override with a different institution

    assert.strictEqual(res.status, 200);

    // Verify that ALL recorded filters use the token's institutionId, NOT the one in the body
    recordedFilters.pendingStudentFilters.forEach((filter, i) => {
      assert.strictEqual(
        filter.institutionId,
        tokenInstitutionId,
        `PendingStudent filter ${i} must use token institutionId '${tokenInstitutionId}', not request body`
      );
      assert.notStrictEqual(
        filter.institutionId,
        'iB',
        `PendingStudent filter ${i} must not contain body institutionId 'iB'`
      );
    });

    recordedFilters.enrollmentFilters.forEach((filter, i) => {
      assert.strictEqual(
        filter.institutionId,
        tokenInstitutionId,
        `InstitutionEnrollment filter ${i} must use token institutionId '${tokenInstitutionId}', not request body`
      );
      assert.notStrictEqual(
        filter.institutionId,
        'iB',
        `InstitutionEnrollment filter ${i} must not contain body institutionId 'iB'`
      );
    });
  } finally {
    rosters._deps = null;
  }
});

test('funnel is forbidden for an unauthenticated caller', async () => {
  const a = express();
  a.use(express.json());
  a.use('/api/institution', rosters);
  const res = await request(a)
    .get('/api/institution/cohorts/c1/funnel');
  assert.strictEqual(res.status, 401);
});

test('funnel is allowed for all required roles: institution_admin', async () => {
  rosters._deps = {
    PendingStudent: { countDocuments: async () => 1 },
    InstitutionEnrollment: { countDocuments: async () => 1 },
  };

  try {
    const res = await request(appAs('iA', 'institution_admin'))
      .get('/api/institution/cohorts/c1/funnel')
      .set('Authorization', `Bearer ${tok('iA', 'institution_admin')}`);
    assert.strictEqual(res.status, 200, 'institution_admin should have access');
  } finally {
    rosters._deps = null;
  }
});

test('funnel is allowed for all required roles: faculty', async () => {
  rosters._deps = {
    PendingStudent: { countDocuments: async () => 1 },
    InstitutionEnrollment: { countDocuments: async () => 1 },
  };

  try {
    const res = await request(appAs('iA', 'faculty'))
      .get('/api/institution/cohorts/c1/funnel')
      .set('Authorization', `Bearer ${tok('iA', 'faculty')}`);
    assert.strictEqual(res.status, 200, 'faculty should have access');
  } finally {
    rosters._deps = null;
  }
});

test('funnel is allowed for all required roles: viewer', async () => {
  rosters._deps = {
    PendingStudent: { countDocuments: async () => 1 },
    InstitutionEnrollment: { countDocuments: async () => 1 },
  };

  try {
    const res = await request(appAs('iA', 'viewer'))
      .get('/api/institution/cohorts/c1/funnel')
      .set('Authorization', `Bearer ${tok('iA', 'viewer')}`);
    assert.strictEqual(res.status, 200, 'viewer should have access');
  } finally {
    rosters._deps = null;
  }
});
