const test = require('node:test');
const assert = require('node:assert');
const { commitRoster } = require('../../services/institution/rosterService');

test('commitRoster creates a PendingStudent per valid row with an invite token', async () => {
  const created = [];
  const PendingStudent = { create: async (doc) => { created.push(doc); return { _id: 'p'+created.length, ...doc }; } };
  const rosterUpload = { _id: 'r1', institutionId: 'i1', departmentId: 'd1', cohortId: 'c1', status: 'validated', save: async function () { this._saved = true; } };
  const rows = [{ name: 'A', rollNumber: '1', email: 'a@x.edu', phone: '+91' }, { name: 'B', rollNumber: '2', email: 'b@x.edu', phone: '+92' }];
  const res = await commitRoster({ rosterUpload, validRows: rows, deps: { PendingStudent, randomToken: () => 'tok' } });
  assert.strictEqual(res.created, 2);
  assert.strictEqual(created[0].institutionId, 'i1');
  assert.strictEqual(created[0].inviteToken, 'tok');
  assert.strictEqual(created[0].status, 'pending');
  assert.strictEqual(rosterUpload.status, 'committed');
  assert.strictEqual(rosterUpload._saved, true);
});
