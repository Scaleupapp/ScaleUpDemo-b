const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
delete require.cache[require.resolve('../../models/PendingStudent')];
delete require.cache[require.resolve('../../models/RosterUpload')];
const PendingStudent = require('../../models/PendingStudent');
const RosterUpload = require('../../models/RosterUpload');

test('PendingStudent requires institutionId/cohortId, lowercases email, defaults status pending', () => {
  const bad = new PendingStudent({}).validateSync();
  assert.ok(bad.errors.institutionId && bad.errors.cohortId);
  const ok = new PendingStudent({ institutionId: new mongoose.Types.ObjectId(), departmentId: new mongoose.Types.ObjectId(), cohortId: new mongoose.Types.ObjectId(), email: 'A@B.EDU', phone: '+9198', rollNumber: '1' });
  assert.strictEqual(ok.validateSync(), undefined);
  assert.strictEqual(ok.email, 'a@b.edu');
  assert.strictEqual(ok.status, 'pending');
});

test('RosterUpload rejects bad status and defaults to validated', () => {
  const ok = new RosterUpload({ institutionId: new mongoose.Types.ObjectId(), departmentId: new mongoose.Types.ObjectId(), cohortId: new mongoose.Types.ObjectId(), uploadedBy: new mongoose.Types.ObjectId(), rowCount: 5, validRows: 4 });
  assert.strictEqual(ok.validateSync(), undefined);
  assert.strictEqual(ok.status, 'validated');
  assert.ok(new RosterUpload({ institutionId: new mongoose.Types.ObjectId(), departmentId: new mongoose.Types.ObjectId(), cohortId: new mongoose.Types.ObjectId(), uploadedBy: new mongoose.Types.ObjectId(), status: 'nope' }).validateSync().errors.status);
});
