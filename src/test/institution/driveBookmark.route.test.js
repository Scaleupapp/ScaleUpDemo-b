'use strict';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');
const router = require('../../routes/institution/studentAssessments');

function appWith(deps) {
  router._deps = deps;
  const a = express(); a.use(express.json());
  a.use('/api/v2/me', router);
  return a;
}
const authStub = (userId) => (req, _res, next) => { req.user = { userId }; next(); };

test('POST bookmark: calls updateOne with correct userId and driveId', async () => {
  let capturedFilter, capturedUpdate, capturedOpts;
  const app = appWith({
    auth: authStub('user1'),
    DriveBookmark: {
      updateOne: async (filter, update, opts) => {
        capturedFilter = filter;
        capturedUpdate = update;
        capturedOpts = opts;
        return { upsertedCount: 1 };
      },
    },
  });
  const res = await request(app).post('/api/v2/me/placement/companies/drive123/bookmark');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(String(capturedFilter.userId), 'user1');
  assert.strictEqual(String(capturedFilter.driveId), 'drive123');
  assert.ok(capturedUpdate.$setOnInsert, '$setOnInsert should be present');
  assert.strictEqual(capturedOpts.upsert, true);
  router._deps = null;
});

test('DELETE bookmark: calls deleteOne with correct userId and driveId', async () => {
  let capturedFilter;
  const app = appWith({
    auth: authStub('user1'),
    DriveBookmark: {
      deleteOne: async (filter) => { capturedFilter = filter; return { deletedCount: 1 }; },
    },
  });
  const res = await request(app).delete('/api/v2/me/placement/companies/drive456/bookmark');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(String(capturedFilter.userId), 'user1');
  assert.strictEqual(String(capturedFilter.driveId), 'drive456');
  router._deps = null;
});

test('GET companies: returns bookmarked:true for bookmarked drive, false otherwise', async () => {
  const drive1 = { _id: 'aaa', name: 'Bookmarked Corp', driveDate: new Date('2026-10-01') };
  const drive2 = { _id: 'bbb', name: 'Not Bookmarked Corp', driveDate: new Date('2026-11-01') };
  const app = appWith({
    auth: authStub('stu1'),
    InstitutionEnrollment: {
      find: () => ({ lean: async () => [{ cohortId: 'c1', institutionId: 'inst1' }] }),
    },
    PlacementDrive: {
      find: () => ({ lean: async () => [drive1, drive2] }),
    },
    DriveBookmark: {
      find: () => ({ lean: async () => [{ driveId: 'aaa' }] }),
    },
  });
  const res = await request(app).get('/api/v2/me/placement/companies');
  assert.strictEqual(res.status, 200);
  const data = res.body.data;
  const bookmarked = data.find((d) => d.name === 'Bookmarked Corp');
  const notBookmarked = data.find((d) => d.name === 'Not Bookmarked Corp');
  assert.strictEqual(bookmarked.bookmarked, true);
  assert.strictEqual(notBookmarked.bookmarked, false);
  router._deps = null;
});
