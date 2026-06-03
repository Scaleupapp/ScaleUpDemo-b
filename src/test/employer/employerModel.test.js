// src/test/employer/employerModel.test.js
'use strict';
const assert = require('assert');
const EmployerAccount = require('../../models/EmployerAccount');
let pass = 0, fail = 0;
function ok(d, fn){ try{ fn(); pass++; }catch(e){ fail++; console.error(d, e.message);} }

ok('defaults: unverified + pending', () => {
  const e = new EmployerAccount({ email: 'a@techco.com', companyName: 'TechCo', name: 'Aarti' });
  assert.strictEqual(e.emailVerified, false);
  assert.strictEqual(e.approvalStatus, 'pending');
  assert.strictEqual(e.role, 'employer');
});
ok('email required', () => {
  const e = new EmployerAccount({ companyName: 'X', name: 'Y' });
  assert.ok(e.validateSync().errors.email);
});
ok('approvalStatus enum', () => {
  const e = new EmployerAccount({ email: 'a@b.com', companyName: 'X', name: 'Y', approvalStatus: 'bogus' });
  assert.ok(e.validateSync().errors.approvalStatus);
});
console.log(`# tests 3\n# pass ${pass}\n# fail ${fail}`);
process.exit(fail ? 1 : 0);
