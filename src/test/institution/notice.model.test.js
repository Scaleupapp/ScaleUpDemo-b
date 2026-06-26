'use strict';
const test = require('node:test');
const assert = require('node:assert');
const InstitutionNotice = require('../../models/InstitutionNotice');
const NoticeRead = require('../../models/NoticeRead');
const oid = '507f1f77bcf86cd799439011';

test('InstitutionNotice requires institutionId, cohortId, title, body', () => {
  const err = new InstitutionNotice({}).validateSync();
  assert.ok(err.errors.institutionId && err.errors.cohortId && err.errors.title && err.errors.body);
});
test('InstitutionNotice defaults pinned=false and keeps attachment', () => {
  const n = new InstitutionNotice({ institutionId: oid, cohortId: oid, title: 'T', body: 'B', attachment: { s3Key: 'k', fileName: 'f.pdf', mime: 'application/pdf' } });
  assert.strictEqual(n.pinned, false);
  assert.strictEqual(n.attachment.fileName, 'f.pdf');
});
test('NoticeRead requires noticeId and userId and defaults readAt', () => {
  const err = new NoticeRead({}).validateSync();
  assert.ok(err.errors.noticeId && err.errors.userId);
  const r = new NoticeRead({ noticeId: oid, userId: oid });
  assert.ok(r.readAt instanceof Date);
});
