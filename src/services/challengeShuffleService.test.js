const test = require('node:test');
const assert = require('node:assert');
const svc = require('./challengeShuffleService');

test('buildShuffle: same seed → same permutation', () => {
  const a = svc.buildShuffle('user1', 'chal1', 15);
  const b = svc.buildShuffle('user1', 'chal1', 15);
  assert.deepEqual(a, b);
});

test('buildShuffle: different users → different permutations', () => {
  const a = svc.buildShuffle('user1', 'chal1', 15);
  const b = svc.buildShuffle('user2', 'chal1', 15);
  assert.notDeepEqual(a.questionOrder, b.questionOrder);
});

test('buildShuffle: questionOrder is a valid permutation', () => {
  const s = svc.buildShuffle('user1', 'chal1', 15);
  assert.equal(s.questionOrder.length, 15);
  const set = new Set(s.questionOrder);
  assert.equal(set.size, 15);
  for (const i of s.questionOrder) assert.ok(i >= 0 && i < 15);
});

test('buildShuffle: optionLabelMap rotates A/B/C/D', () => {
  const s = svc.buildShuffle('user1', 'chal1', 15);
  for (let q = 0; q < 15; q++) {
    const map = s.optionLabelMap[q];
    const values = new Set(Object.values(map));
    assert.deepEqual([...values].sort(), ['A', 'B', 'C', 'D']);
    assert.deepEqual(Object.keys(map).sort(), ['A', 'B', 'C', 'D']);
  }
});

test('translateAnswer: inverse mapping round-trips', () => {
  const s = svc.buildShuffle('user1', 'chal1', 15);
  // User sees question position 3, selects label "C" — what was the canonical?
  const orig = svc.translateAnswer(s, 3, 'C');
  // Round-trip: forward-translate the canonical back via optionLabelMap.
  const forward = s.optionLabelMap[orig.originalQuestionIdx][orig.originalLabel];
  assert.equal(forward, 'C');
});
