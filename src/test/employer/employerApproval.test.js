// src/test/employer/employerApproval.test.js
'use strict';
const assert = require('assert');
const svc = require('../../services/employer/employerApprovalService');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }

(async () => {
  let updated = null;
  svc._update = async (id, patch) => { updated = { id, patch }; return { _id: id, ...patch }; };
  await ok('approve sets approved + approver', async () => {
    await svc.approve('e1', 'admin1');
    assert.strictEqual(updated.patch.approvalStatus, 'approved');
    assert.strictEqual(String(updated.patch.approvedBy), 'admin1');
    assert.ok(updated.patch.approvedAt);
  });
  await ok('reject sets rejected', async () => {
    await svc.reject('e1', 'admin1');
    assert.strictEqual(updated.patch.approvalStatus, 'rejected');
  });
  console.log(`# tests 2\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();
