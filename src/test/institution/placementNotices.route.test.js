'use strict';
const test = require('node:test'); const assert = require('node:assert');
const express = require('express'); const request = require('supertest');
const router = require('../../routes/institution/studentAssessments');
function appWith(deps) { router._deps = deps; const a = express(); a.use(express.json()); a.use('/api/v2/me', router); return a; }
const authStub = (userId) => (req, _res, next) => { req.user = { userId }; next(); };

test('notices: cohort-scoped, pinned-first, with read flag + attachment url', async () => {
  const app = appWith({
    auth: authStub('stu1'),
    InstitutionEnrollment: { find: () => ({ lean: async () => ([{ cohortId: 'c1' }]) }) },
    InstitutionNotice: { find: (q) => { assert.deepStrictEqual(q.cohortId.$in, ['c1']); return { sort: () => ({ lean: async () => ([
      { _id: 'n1', title: 'A', pinned: true, attachment: { s3Key: 'k', fileName: 'f.pdf', mime: 'application/pdf' } },
      { _id: 'n2', title: 'B', pinned: false },
    ]) }) }; } },
    NoticeRead: { find: () => ({ lean: async () => ([{ noticeId: 'n2' }]) }) },
    generateDownloadURL: async (key) => `https://signed/${key}`,
  });
  const res = await request(app).get('/api/v2/me/placement/notices');
  assert.strictEqual(res.status, 200);
  const byId = Object.fromEntries(res.body.data.map((n) => [n._id, n]));
  assert.strictEqual(byId.n1.read, false);
  assert.strictEqual(byId.n2.read, true);
  assert.strictEqual(byId.n1.attachment.url, 'https://signed/k');
  router._deps = null;
});

test('mark-read upserts and returns success', async () => {
  let upserted = null;
  const app = appWith({ auth: authStub('stu1'), NoticeRead: { updateOne: async (filter, update, opts) => { upserted = { filter, opts }; return { acknowledged: true }; } } });
  const res = await request(app).post('/api/v2/me/placement/notices/n1/read');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(upserted.filter.noticeId, 'n1');
  assert.strictEqual(upserted.filter.userId, 'stu1');
  assert.strictEqual(upserted.opts.upsert, true);
  router._deps = null;
});

test('notices: empty when no enrollment', async () => {
  const app = appWith({ auth: authStub('stu1'), InstitutionEnrollment: { find: () => ({ lean: async () => ([]) }) } });
  const res = await request(app).get('/api/v2/me/placement/notices');
  assert.deepStrictEqual(res.body.data, []);
  router._deps = null;
});
