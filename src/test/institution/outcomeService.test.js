'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { summarize } = require('../../services/institution/outcomeService');
test('summarize computes placement %, package stats, companies, branch-wise', () => {
  const offers = [
    { rollNumber: 'R1', branch: 'CSE', companyName: 'Acme', ctc: 30, status: 'accepted' },
    { rollNumber: 'R2', branch: 'CSE', companyName: 'Acme', ctc: 12, status: 'joined' },
    { rollNumber: 'R3', branch: 'ECE', companyName: 'Globex', ctc: 18, status: 'offered' }, // not placed
    { rollNumber: 'R1', branch: 'CSE', companyName: 'Initech', ctc: 24, status: 'declined' }, // dup student, not placed
  ];
  const s = summarize(offers, 4); // cohortSize 4
  assert.strictEqual(s.placedCount, 2);            // R1(accepted), R2(joined)
  assert.strictEqual(s.placementPercent, 50);      // 2/4
  assert.strictEqual(s.highestCtc, 30);
  assert.strictEqual(s.averageCtc, 21);            // (30+12)/2
  assert.strictEqual(s.medianCtc, 21);             // median of [12,30]
  assert.strictEqual(s.companiesVisited, 3);       // Acme, Globex, Initech
  assert.deepStrictEqual(s.statusCounts, { offered: 1, accepted: 1, joined: 1, declined: 1 });
  assert.deepStrictEqual(s.branchWise, [{ branch: 'CSE', placed: 2 }]); // only placed grouped
  assert.strictEqual(s.cohortSize, 4);
});
test('summarize handles empty + zero cohort', () => {
  const s = summarize([], 0);
  assert.strictEqual(s.placementPercent, 0); assert.strictEqual(s.placedCount, 0);
  assert.strictEqual(s.highestCtc, null); assert.deepStrictEqual(s.branchWise, []);
});
