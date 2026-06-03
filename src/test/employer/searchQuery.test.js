// src/test/employer/searchQuery.test.js
'use strict';
const assert = require('assert');
const { buildQuery } = require('../../services/employer/employerSearchService');
let pass = 0, fail = 0;
function ok(d, fn){ try{ fn(); pass++; }catch(e){ fail++; console.error(d, e.message);} }

ok('always constrains to opted-in active', () => {
  const q = buildQuery({});
  assert.strictEqual(q.optedIn, true);
  assert.strictEqual(q.status, 'active');
});
ok('band filter -> $in on readinessBand', () => {
  const q = buildQuery({ bands: ['Strong', 'Exceptional'] });
  assert.deepStrictEqual(q['snapshot.readinessBand'], { $in: ['Strong', 'Exceptional'] });
});
ok('role filter -> objectiveType', () => {
  const q = buildQuery({ objectiveType: 'interview_preparation' });
  assert.strictEqual(q['snapshot.objectiveType'], 'interview_preparation');
});
ok('skills -> $in on competency names', () => {
  const q = buildQuery({ skills: ['System Design'] });
  assert.deepStrictEqual(q['snapshot.competencies.name'], { $in: ['System Design'] });
});
ok('city -> case-insensitive exact', () => {
  const q = buildQuery({ city: 'bangalore' });
  assert.ok(q.city instanceof RegExp);
  assert.ok(q.city.test('Bangalore'));
});
ok('proof verified -> snapshot.verified true', () => {
  assert.strictEqual(buildQuery({ proof: 'verified' })['snapshot.verified'], true);
});
ok('proof achieved -> snapshot.achieved true', () => {
  assert.strictEqual(buildQuery({ proof: 'achieved' })['snapshot.achieved'], true);
});
ok('ignores unknown/empty filters', () => {
  const q = buildQuery({ bands: [], skills: [], city: '' });
  assert.ok(!('snapshot.readinessBand' in q));
  assert.ok(!('city' in q));
});
console.log(`# tests 8\n# pass ${pass}\n# fail ${fail}`);
process.exit(fail ? 1 : 0);
