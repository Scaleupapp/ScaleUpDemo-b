const test = require('node:test');
const assert = require('node:assert');

// Pre-stub openai config so the module loads without a real OPENAI_API_KEY.
// Individual LLM tests override this stub as needed.
{
  const openaiPath = require.resolve('../config/openai');
  if (!require.cache[openaiPath]) {
    require.cache[openaiPath] = {
      exports: { chat: { completions: { create: async () => ({ choices: [] }) } } },
      loaded: true, id: openaiPath,
    };
  }
}

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

test('generatePoolFromLLM returns parsed questions on valid response', async (t) => {
  const stubResponse = {
    choices: [{ message: { content: JSON.stringify({
      questions: [
        { competency: 'sql', difficulty: 'easy', questionText: 'q1', options: [
          { label: 'A', text: 'a' }, { label: 'B', text: 'b', misconception: { tag: 'x', explanation: 'y' } },
          { label: 'C', text: 'c', misconception: { tag: 'z', explanation: 'w' } },
          { label: 'D', text: 'd', misconception: { tag: 'q', explanation: 'r' } },
        ], correctAnswer: 'A' },
      ],
    }) } }],
  };
  // Stub the openai module
  const openaiPath = require.resolve('../config/openai');
  require.cache[openaiPath] = {
    exports: { chat: { completions: { create: async () => stubResponse } } },
    loaded: true, id: openaiPath,
  };
  // Re-require pool service
  delete require.cache[require.resolve('./diagnosticPoolService')];
  const { _internal } = require('./diagnosticPoolService');

  const allocation = [{ name: 'sql', easy: 1, medium: 0, hard: 0 }];
  const out = await _internal.generatePoolFromLLM(allocation, { objective: 'data scientist' });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].competency, 'sql');
});

test('generatePoolFromLLM returns empty array when LLM throws', async () => {
  const openaiPath = require.resolve('../config/openai');
  require.cache[openaiPath] = {
    exports: { chat: { completions: { create: async () => { throw new Error('rate limit'); } } } },
    loaded: true, id: openaiPath,
  };
  delete require.cache[require.resolve('./diagnosticPoolService')];
  const { _internal } = require('./diagnosticPoolService');
  const out = await _internal.generatePoolFromLLM([{ name: 'x', easy: 1, medium: 0, hard: 0 }], {});
  assert.deepStrictEqual(out, []);
});

test('generatePoolFromLLM returns empty array when LLM returns malformed JSON', async () => {
  const openaiPath = require.resolve('../config/openai');
  require.cache[openaiPath] = {
    exports: { chat: { completions: { create: async () => ({ choices: [{ message: { content: 'not json' } }] }) } } },
    loaded: true, id: openaiPath,
  };
  delete require.cache[require.resolve('./diagnosticPoolService')];
  const { _internal } = require('./diagnosticPoolService');
  const out = await _internal.generatePoolFromLLM([{ name: 'x', easy: 1, medium: 0, hard: 0 }], {});
  assert.deepStrictEqual(out, []);
});
