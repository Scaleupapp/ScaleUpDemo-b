// src/test/employer/explain.test.js
'use strict';
const assert = require('assert');
const { explain } = require('../../services/employer/talentRankingService');
let pass = 0, fail = 0;
function ok(d, fn){ try{ fn(); pass++; }catch(e){ fail++; console.error(d, e.message);} }

ok('achiever + verified + exceptional yields those signals in priority order', () => {
  const sigs = explain({ snapshot: { achieved: true, verified: true, readinessBand: 'Exceptional', readinessScore: 88, target: 80,
    evidence: { assessments: 14, capstonesGraded: 3, interviews: 2, coveragePct: 92 }, lastActiveAt: new Date() } });
  const keys = sigs.map((s) => s.key);
  assert.deepStrictEqual(keys.slice(0, 3), ['achieved', 'verified', 'band']);
  assert.ok(sigs.find((s) => s.key === 'band').detail.includes('88'));
});
ok('omits signals not present (no achieved/verified)', () => {
  const sigs = explain({ snapshot: { achieved: false, verified: false, readinessBand: 'Strong', readinessScore: 81, target: 80,
    evidence: { assessments: 3, capstonesGraded: 0, interviews: 0, coveragePct: 50 }, lastActiveAt: new Date('2019-01-01') } });
  assert.ok(!sigs.find((s) => s.key === 'achieved'));
  assert.ok(!sigs.find((s) => s.key === 'verified'));
  assert.ok(!sigs.find((s) => s.key === 'recency')); // stale
});
ok('every signal has label + detail + kind', () => {
  const sigs = explain({ snapshot: { achieved: true, verified: true, readinessBand: 'Strong', readinessScore: 80, target: 80,
    evidence: { assessments: 5, capstonesGraded: 1, interviews: 0, coveragePct: 70 }, lastActiveAt: new Date() } });
  sigs.forEach((s) => { assert.ok(s.label && s.detail && s.kind); });
});
console.log(`# tests 3\n# pass ${pass}\n# fail ${fail}`);
process.exit(fail ? 1 : 0);
