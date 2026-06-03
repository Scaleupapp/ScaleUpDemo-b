// src/test/employer/connectionView.test.js
'use strict';
const assert = require('assert');
const { employerView, candidateView } = require('../../services/employer/connectionViewService');
let pass = 0, fail = 0;
function ok(d, fn){ try{ fn(); pass++; }catch(e){ fail++; console.error(d, e.message);} }

const profile = { _id: '0123456789abcdef01234567', snapshot: { roleLabel: 'Backend Engineer', proofToken: 'PTOKEN' } };
const candidate = { firstName: 'Priya', lastName: 'Sharma', email: 'priya@x.com', phone: '+91999' };
const employer = { companyName: 'TechCo', name: 'Aarti', email: 'aarti@techco.com' };

ok('employerView pending: NO candidate PII', () => {
  const v = employerView({ _id: 'c1', status: 'requested', message: 'hi', createdAt: new Date() }, profile, candidate);
  const json = JSON.stringify(v);
  assert.ok(!json.includes('Priya') && !json.includes('priya@x.com') && !json.includes('+91999'));
  assert.ok(!json.includes('PTOKEN'));
  assert.ok(v.handle.startsWith('Candidate #'));
  assert.strictEqual(v.status, 'requested');
  assert.strictEqual(v.reveal, undefined);
});
ok('employerView approved: reveals candidate contact + proof url', () => {
  const v = employerView({ _id: 'c1', status: 'approved', createdAt: new Date() }, profile, candidate);
  assert.strictEqual(v.reveal.name, 'Priya Sharma');
  assert.strictEqual(v.reveal.email, 'priya@x.com');
  assert.strictEqual(v.reveal.phone, '+91999');
  assert.ok(v.reveal.proofUrl.includes('/r/PTOKEN'));
});
ok('candidateView pending: employer masked', () => {
  const v = candidateView({ _id: 'c1', status: 'requested', roleContext: 'Backend Engineer', message: 'hi', createdAt: new Date() }, employer);
  const json = JSON.stringify(v);
  assert.ok(!json.includes('TechCo') && !json.includes('aarti@techco.com'));
  assert.strictEqual(v.employer, 'A verified employer');
  assert.strictEqual(v.roleContext, 'Backend Engineer');
  assert.strictEqual(v.reveal, undefined);
});
ok('candidateView approved: reveals employer', () => {
  const v = candidateView({ _id: 'c1', status: 'approved', createdAt: new Date() }, employer);
  assert.strictEqual(v.reveal.companyName, 'TechCo');
  assert.strictEqual(v.reveal.email, 'aarti@techco.com');
});
console.log(`# tests 4\n# pass ${pass}\n# fail ${fail}`);
process.exit(fail ? 1 : 0);
