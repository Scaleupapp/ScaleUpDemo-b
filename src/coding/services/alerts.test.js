'use strict';

const test = require('node:test');
const assert = require('node:assert');

const alerts = require('./alerts');

function captureWarn(fn) {
  const orig = console.warn;
  const seen = [];
  console.warn = (...args) => seen.push(args.join(' '));
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.warn = orig;
    })
    .then(() => seen);
}

test('alerts.fire is a no-op without category/title', async () => {
  const seen = await captureWarn(async () => {
    delete process.env.ALERT_WEBHOOK_URL;
    await alerts.fire({});
    await alerts.fire({ category: 'x' });
    await alerts.fire({ title: 'y' });
  });
  assert.strictEqual(seen.length, 0);
});

test('alerts.fire logs to stderr when ALERT_WEBHOOK_URL is unset', async () => {
  alerts._resetDedup();
  delete process.env.ALERT_WEBHOOK_URL;
  const seen = await captureWarn(async () => {
    await alerts.fire({ category: 'test.cat', title: 'something happened', detail: 'oh no' });
  });
  assert.strictEqual(seen.length, 1);
  assert.match(seen[0], /test\.cat/);
  assert.match(seen[0], /something happened/);
});

test('alerts.fire dedupes within window by (category, dedupKey)', async () => {
  alerts._resetDedup();
  delete process.env.ALERT_WEBHOOK_URL;
  process.env.ALERT_DEDUP_WINDOW_MS = '60000';
  const seen = await captureWarn(async () => {
    await alerts.fire({ category: 'c', title: 't1', dedupKey: 'k' });
    await alerts.fire({ category: 'c', title: 't2', dedupKey: 'k' });
    await alerts.fire({ category: 'c', title: 't3', dedupKey: 'k2' });
  });
  assert.strictEqual(seen.length, 2, 'second alert with same dedup key should be swallowed');
});

test('alerts.fire posts to webhook when ALERT_WEBHOOK_URL is set', async () => {
  alerts._resetDedup();
  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, body: opts.body });
    return { ok: true, status: 200 };
  };
  try {
    process.env.ALERT_WEBHOOK_URL = 'https://hooks.example/test';
    await alerts.fire({
      category: 'cost.session-over-budget',
      severity: 'error',
      title: 'session blew budget',
      detail: 'usd=$1.42',
      fields: { session_id: 'abc', total_usd: '1.42' },
    });
  } finally {
    global.fetch = origFetch;
    delete process.env.ALERT_WEBHOOK_URL;
  }
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'https://hooks.example/test');
  const payload = JSON.parse(calls[0].body);
  assert.match(payload.text, /session blew budget/);
  assert.ok(Array.isArray(payload.attachments));
  assert.strictEqual(payload.attachments[0].color, '#c0392b');
});

test('alerts.fire swallows webhook errors', async () => {
  alerts._resetDedup();
  const origFetch = global.fetch;
  global.fetch = async () => { throw new Error('network down'); };
  try {
    process.env.ALERT_WEBHOOK_URL = 'https://hooks.example/test';
    // Should not throw.
    await alerts.fire({ category: 'c', title: 't' });
  } finally {
    global.fetch = origFetch;
    delete process.env.ALERT_WEBHOOK_URL;
  }
});
