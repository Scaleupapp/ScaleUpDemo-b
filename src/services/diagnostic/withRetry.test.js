const test = require('node:test');
const assert = require('node:assert');

delete require.cache[require.resolve('./withRetry')];
const { withRetry, isRetryable } = require('./withRetry');

test('isRetryable: 429 -> true', () => {
  assert.strictEqual(isRetryable({ status: 429 }), true);
});

test('isRetryable: 500 -> true', () => {
  assert.strictEqual(isRetryable({ status: 503 }), true);
});

test('isRetryable: 400 -> false', () => {
  assert.strictEqual(isRetryable({ status: 400 }), false);
});

test('isRetryable: ECONNRESET -> true', () => {
  assert.strictEqual(isRetryable({ code: 'ECONNRESET' }), true);
});

test('withRetry: succeeds on first try when fn returns', async () => {
  let calls = 0;
  const result = await withRetry(async () => { calls++; return 'ok'; });
  assert.strictEqual(result, 'ok');
  assert.strictEqual(calls, 1);
});

test('withRetry: retries on 429 then succeeds', async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) { const e = new Error('rate limit'); e.status = 429; throw e; }
      return 'eventually ok';
    },
    { backoffs: [10, 10, 10] }
  );
  assert.strictEqual(result, 'eventually ok');
  assert.strictEqual(calls, 3);
});

test('withRetry: gives up after max retries', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => { calls++; const e = new Error('still failing'); e.status = 503; throw e; },
      { backoffs: [10, 10] }
    ),
    /still failing/
  );
  assert.strictEqual(calls, 3); // 1 initial + 2 retries
});

test('withRetry: does not retry non-retryable errors', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => { calls++; const e = new Error('bad input'); e.status = 400; throw e; },
      { backoffs: [10, 10, 10] }
    ),
    /bad input/
  );
  assert.strictEqual(calls, 1); // No retry
});
