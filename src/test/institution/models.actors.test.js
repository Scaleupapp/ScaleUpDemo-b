// src/test/institution/models.actors.test.js
const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
delete require.cache[require.resolve('../../models/InstitutionUser')];
delete require.cache[require.resolve('../../models/InstitutionEnrollment')];
const InstitutionUser = require('../../models/InstitutionUser');
const InstitutionEnrollment = require('../../models/InstitutionEnrollment');

test('InstitutionUser requires institutionId, email, role; rejects bad role; defaults tokenVersion 0', () => {
  const bad = new InstitutionUser({ email: 'a@b.edu', role: 'superuser' }).validateSync();
  assert.ok(bad.errors.institutionId, 'institutionId required');
  assert.ok(bad.errors.role, 'role enum enforced');
  const ok = new InstitutionUser({ institutionId: new mongoose.Types.ObjectId(), email: 'a@b.edu', role: 'tpo_head' });
  assert.strictEqual(ok.validateSync(), undefined);
  assert.strictEqual(ok.tokenVersion, 0);
});

test('InstitutionEnrollment defaults status to pending', () => {
  const en = new InstitutionEnrollment({ institutionId: new mongoose.Types.ObjectId(), departmentId: new mongoose.Types.ObjectId(), cohortId: new mongoose.Types.ObjectId(), rollNumber: '4127' });
  assert.strictEqual(en.validateSync(), undefined);
  assert.strictEqual(en.status, 'pending');
});
