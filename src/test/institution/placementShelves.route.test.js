'use strict';
const test = require('node:test'); const assert = require('node:assert');
const express = require('express'); const request = require('supertest');
const router = require('../../routes/institution/studentAssessments');
function appWith(deps) { router._deps = deps; const a = express(); a.use(express.json()); a.use('/api/v2/me', router); return a; }
const authStub = (userId) => (req, _res, next) => { req.user = { userId }; next(); };

test('shelves: cohort+institution scoped, items with presigned file url, no s3Key', async () => {
  const app = appWith({
    auth: authStub('stu1'),
    InstitutionEnrollment: { find: () => ({ lean: async () => ([{ cohortId: 'c1', institutionId: 'inst-A' }]) }) },
    Shelf: { find: (q) => { assert.deepStrictEqual(q.institutionId.$in, ['inst-A']); assert.deepStrictEqual(q.cohortId.$in, ['c1']); return { sort: () => ({ lean: async () => ([{ _id: 's1', title: 'DSA', order: 0 }]) }) }; } },
    ShelfItem: { find: () => ({ sort: () => ({ lean: async () => ([
      { _id: 'i1', shelfId: 's1', type: 'link', title: 'GFG', url: 'https://g', note: 'n', order: 0 },
      { _id: 'i2', shelfId: 's1', type: 'file', title: 'PDF', s3Key: 'k', fileName: 'a.pdf', mime: 'application/pdf', order: 1 },
    ]) }) }) },
    generateDownloadURL: async (key) => `https://signed/${key}`,
  });
  const res = await request(app).get('/api/v2/me/placement/shelves');
  assert.strictEqual(res.status, 200);
  const shelf = res.body.data[0];
  assert.strictEqual(shelf.items[0].url, 'https://g');
  assert.strictEqual(shelf.items[1].url, 'https://signed/k');
  assert.strictEqual(shelf.items[1].s3Key, undefined);
  router._deps = null;
});
test('shelves: empty when no enrollment', async () => {
  const app = appWith({ auth: authStub('stu1'), InstitutionEnrollment: { find: () => ({ lean: async () => ([]) }) } });
  const res = await request(app).get('/api/v2/me/placement/shelves');
  assert.deepStrictEqual(res.body.data, []);
  router._deps = null;
});
