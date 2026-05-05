const test = require('node:test');
const assert = require('node:assert');

delete require.cache[require.resolve('./llmCallBudget')];
const budget = require('./llmCallBudget');

test('llmCallBudget: increment counts up', () => {
  budget.reset();
  budget.increment();
  budget.increment();
  assert.strictEqual(budget.getCount(), 2);
});

test('llmCallBudget: throws LLMBudgetExceededError past limit', () => {
  budget.reset();
  // Default limit is 20000 from env or fallback. Manually crank limit by re-requiring with env set.
  // Simpler: drive count past limit by direct calls.
  // We need a way to override the limit for tests. Use the existing env approach:
  process.env.MAX_LLM_CALLS = '3';
  delete require.cache[require.resolve('./llmCallBudget')];
  const b = require('./llmCallBudget');
  b.reset();
  b.increment(); // 1
  b.increment(); // 2
  b.increment(); // 3
  assert.throws(() => b.increment(), /budget exceeded/i);
  delete process.env.MAX_LLM_CALLS;
});

test('llmCallBudget: reset zeroes count and clears exceeded flag', () => {
  process.env.MAX_LLM_CALLS = '2';
  delete require.cache[require.resolve('./llmCallBudget')];
  const b = require('./llmCallBudget');
  b.reset();
  b.increment(); b.increment();
  assert.throws(() => b.increment());
  b.reset();
  assert.strictEqual(b.getCount(), 0);
  // After reset, new increments succeed
  b.increment();
  assert.strictEqual(b.getCount(), 1);
  delete process.env.MAX_LLM_CALLS;
});
