// src/test/employer/search.test.js
'use strict';
const assert = require('assert');
const svc = require('../../services/employer/employerSearchService');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }

const mk = (id, p) => ({ _id: id, city: 'Bangalore', snapshot: { roleLabel: 'Backend Engineer', readinessBand: 'Strong', readinessScore: 80,
  competencies: [{ name: 'System Design', score: 80 }], evidence: { assessments: 3, coveragePct: 60 }, achieved: false, verified: false, lastActiveAt: new Date('2020-01-01'), ...p } });

(async () => {
  await ok('search ranks + returns browse cards (achiever first)', async () => {
    svc._find = async () => [ mk('aaaa000000000000aaaa0001', {}), mk('bbbb000000000000bbbb0002', { achieved: true }) ];
    const out = await svc.search({});
    assert.strictEqual(out.total, 2);
    assert.strictEqual(out.results[0].achieved, true); // ranked first
    assert.ok(out.results[0].handle.startsWith('Candidate #'));
    assert.ok(!JSON.stringify(out.results).includes('_id')); // no raw id leaked
  });

  await ok('search respects page cap', async () => {
    const many = Array.from({ length: 60 }, (_, i) => mk(String(i).padStart(24, '0'), {}));
    svc._find = async () => many;
    const out = await svc.search({}, { limit: 25 });
    assert.strictEqual(out.results.length, 25);
    assert.strictEqual(out.total, 60);
  });

  await ok('getCandidate returns anonymized profile, no PII', async () => {
    // proofToken inside snapshot; userId at top level — both must be scrubbed by anonymizer
    const rawRow = { ...mk('cccc000000000000cccc0003', { verified: true, proofToken: 'SECRETTOKEN' }), userId: 'USERSECRET' };
    svc._findOne = async () => rawRow;
    const p = await svc.getCandidate('cccc000000000000cccc0003');
    assert.strictEqual(p.verified, true);
    assert.ok(Array.isArray(p.why));
    assert.ok(p.handle.startsWith('Candidate #'));
    assert.ok(!JSON.stringify(p).includes('USERSECRET'));
    assert.ok(!JSON.stringify(p).includes('SECRETTOKEN'));
  });

  await ok('getCandidate null when not found / not in pool', async () => {
    svc._findOne = async () => null;
    assert.strictEqual(await svc.getCandidate('x'), null);
  });

  console.log(`# tests 4\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();
