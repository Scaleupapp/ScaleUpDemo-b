// src/test/employer/connectionAdmin.test.js
'use strict';
const assert = require('assert');
const svc = require('../../services/employer/connectionService');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }

(async () => {
  await ok('adminList returns counts + rows', async () => {
    svc._adminFind = async () => [
      { _id: 'c1', employerId: 'e1', status: 'requested', createdAt: new Date() },
      { _id: 'c2', employerId: 'e1', status: 'approved', createdAt: new Date() },
    ];
    const out = await svc.adminList();
    assert.strictEqual(out.total, 2);
    assert.strictEqual(out.byStatus.requested, 1);
    assert.strictEqual(out.byStatus.approved, 1);
    assert.strictEqual(out.rows.length, 2);
  });
  console.log(`# tests 1\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();
