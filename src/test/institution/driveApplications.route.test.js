'use strict';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');
const { signInstitutionToken } = require('../../services/institution/institutionAuthService');
const institutionAuth = require('../../middleware/institutionAuth');

function stubLoadUser(institutionId, role) {
  institutionAuth._loadUser = async () => ({ _id: 'u1', institutionId, role, status: 'active', tokenVersion: 0, scope: {} });
}

const driveApplications = require('../../routes/institution/driveApplications');

function tok(i, r) { return signInstitutionToken({ _id: 'u1', institutionId: i, role: r, tokenVersion: 0 }); }
function appAs(i, r) { stubLoadUser(i, r); const a = express(); a.use(express.json()); a.use('/api/institution', driveApplications); return a; }

test('viewer cannot add application (403)', async () => {
  const res = await request(appAs('inst-A', 'viewer'))
    .post('/api/institution/cohorts/c1/drives/d1/applications')
    .set('Authorization', `Bearer ${tok('inst-A', 'viewer')}`)
    .send({ studentName: 'Alice' });
  assert.strictEqual(res.status, 403);
  driveApplications._deps = null;
});

test('tpo_head adds application; scope from token, driveId from path, NOT from body', async () => {
  let cap = null;
  driveApplications._deps = {
    driveApplicationService: {
      addApplication: async (scope, cohortId, driveId, body) => {
        cap = { scope, cohortId, driveId, body };
        return { _id: 'a1', ...body };
      }
    }
  };
  const res = await request(appAs('inst-A', 'tpo_head'))
    .post('/api/institution/cohorts/c1/drives/d1/applications')
    .set('Authorization', `Bearer ${tok('inst-A', 'tpo_head')}`)
    .send({ studentName: 'Alice', rollNumber: 'R1', institutionId: 'EVIL', driveId: 'EVIL' });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(cap.scope.institutionId, 'inst-A');
  assert.strictEqual(cap.cohortId, 'c1');
  assert.strictEqual(cap.driveId, 'd1');
  assert.strictEqual(cap.body.studentName, 'Alice');
  driveApplications._deps = null;
});

test('GET /applications returns {stages, applications}', async () => {
  driveApplications._deps = {
    driveApplicationService: {
      listByDrive: async () => ({
        stages: { interested: [], applied: [], shortlisted: [], offered: [], rejected: [] },
        applications: []
      })
    }
  };
  const res = await request(appAs('inst-A', 'viewer'))
    .get('/api/institution/cohorts/c1/drives/d1/applications')
    .set('Authorization', `Bearer ${tok('inst-A', 'viewer')}`);
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.data.stages);
  assert.ok(Array.isArray(res.body.data.applications));
  driveApplications._deps = null;
});

test('PATCH with unknown id → 404', async () => {
  driveApplications._deps = {
    driveApplicationService: {
      moveStage: async () => { throw new Error('APPLICATION_NOT_FOUND'); }
    }
  };
  const res = await request(appAs('inst-A', 'tpo_head'))
    .patch('/api/institution/cohorts/c1/drives/d1/applications/unknownId')
    .set('Authorization', `Bearer ${tok('inst-A', 'tpo_head')}`)
    .send({ stage: 'applied' });
  assert.strictEqual(res.status, 404);
  driveApplications._deps = null;
});

// --- Service unit test ---
test('listByDrive includes bookmark-seeded interested entry for bookmarked student with no application', async () => {
  const driveApplicationService = require('../../services/institution/driveApplicationService');
  const scope = { institutionId: 'inst-A' };
  const cohortId = 'c1';
  const driveId = 'd1';

  // Stub deps: DriveApplication.find returns empty, DriveBookmark.find returns one bookmark
  const deps = {
    DriveApplication: {
      find: () => ({
        lean: async () => []
      })
    },
    DriveBookmark: {
      find: () => ({
        lean: async () => [{ userId: 'u1', driveId: 'd1' }]
      })
    }
  };

  const result = await driveApplicationService.listByDrive(scope, cohortId, driveId, deps);
  assert.ok(result.stages, 'result should have stages');
  assert.ok(Array.isArray(result.applications), 'result should have applications array');
  const seeded = result.applications.find((a) => a._seeded && String(a.studentUserId) === 'u1');
  assert.ok(seeded, 'should include seeded interested entry for bookmarked user u1');
  assert.strictEqual(seeded.stage, 'interested');
});
