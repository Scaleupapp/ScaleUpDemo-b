const test = require('node:test');
const assert = require('node:assert');
const { _internal } = require('./diagnosticPoolService');
const { calculatePoolAllocation } = _internal;

test('calculatePoolAllocation: 3 competencies → ~8 each, total ~24', () => {
  const competencies = [
    { name: 'a', selfRating: 'novice' },
    { name: 'b', selfRating: 'familiar' },
    { name: 'c', selfRating: 'proficient' },
  ];
  const alloc = calculatePoolAllocation(competencies, 24);
  assert.strictEqual(alloc.length, 3);
  for (const a of alloc) {
    const total = a.easy + a.medium + a.hard;
    assert.ok(total >= 7 && total <= 9, `competency ${a.name} got ${total} questions`);
  }
});

test('calculatePoolAllocation: novice → mostly easy', () => {
  const alloc = calculatePoolAllocation([{ name: 'x', selfRating: 'novice' }], 8);
  assert.strictEqual(alloc[0].easy >= alloc[0].medium, true);
  assert.strictEqual(alloc[0].easy >= alloc[0].hard, true);
});

test('calculatePoolAllocation: expert → mostly hard', () => {
  const alloc = calculatePoolAllocation([{ name: 'x', selfRating: 'expert' }], 8);
  assert.ok(alloc[0].hard >= alloc[0].easy, 'expert should get more hard than easy');
});

test('calculatePoolAllocation: 6 competencies → at least 3 each (floor)', () => {
  const competencies = Array.from({ length: 6 }, (_, i) => ({ name: `c${i}`, selfRating: 'familiar' }));
  const alloc = calculatePoolAllocation(competencies, 24);
  for (const a of alloc) {
    const total = a.easy + a.medium + a.hard;
    assert.ok(total >= 3, `floor of 3 violated: ${a.name} got ${total}`);
  }
});

test('calculatePoolAllocation: unsure self-rating treated as novice', () => {
  const a1 = calculatePoolAllocation([{ name: 'x', selfRating: 'unsure' }], 8)[0];
  const a2 = calculatePoolAllocation([{ name: 'x', selfRating: 'novice' }], 8)[0];
  assert.deepStrictEqual(a1, a2);
});
