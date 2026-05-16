const test = require('node:test');
const assert = require('node:assert');
const svc = require('./ghostLeaderboardService');

const cohort = {
  canonicalTopic: 'gmat',
  personaGhosts: [
    { name: 'Aanya', medianOffset: 8, seed: 'gmat:0' },
    { name: 'Vikram', medianOffset: 2, seed: 'gmat:1' },
    { name: 'Priya', medianOffset: -5, seed: 'gmat:2' },
  ],
  historicalStats: { last30dAverageScore: 65, last30dP90Score: 88, sampleSize: 200 },
};

test('compose: returns real entries unchanged when cohort >= 10', () => {
  const real = Array.from({ length: 12 }, (_, i) => ({ userId: `u${i}`, handicappedScore: 100 - i, ghostKind: null }));
  const out = svc.compose({ cohort, realEntries: real, weekStart: new Date('2026-05-11') });
  assert.equal(out.length, 12);
  assert.ok(out.every(e => !e.ghostKind));
});

test('compose: adds historical anchors and personas when cohort < 10', () => {
  const real = Array.from({ length: 3 }, (_, i) => ({ userId: `u${i}`, handicappedScore: 70 - i * 5, ghostKind: null }));
  const out = svc.compose({ cohort, realEntries: real, weekStart: new Date('2026-05-11') });
  const kinds = out.map(e => e.ghostKind);
  assert.equal(kinds.filter(k => k === 'historical').length, 2);
  assert.equal(kinds.filter(k => k === 'persona').length, 3);
  assert.equal(kinds.filter(k => k == null).length, 3);
});

test('compose: ghosts never occupy #1 when real entries exist', () => {
  const real = [{ userId: 'u1', handicappedScore: 30, ghostKind: null }];
  const out = svc.compose({ cohort, realEntries: real, weekStart: new Date('2026-05-11') });
  assert.ok(out[0].ghostKind == null || out[0].userId === 'u1',
    `top spot should be a real user when reals exist; got ${JSON.stringify(out[0])}`);
});

test('compose: sorts by handicappedScore descending', () => {
  const real = [{ userId: 'u1', handicappedScore: 50, ghostKind: null }];
  const out = svc.compose({ cohort, realEntries: real, weekStart: new Date('2026-05-11') });
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i - 1].handicappedScore >= out[i].handicappedScore,
      `unsorted at ${i}: ${out[i-1].handicappedScore} < ${out[i].handicappedScore}`);
  }
});
