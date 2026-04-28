const test = require('node:test');
const assert = require('node:assert');

test('featureFlags exposes day1Diagnostic boolean (defaults false when env unset)', () => {
  delete process.env.FEATURE_DAY1_DIAGNOSTIC;
  delete require.cache[require.resolve('./featureFlags')];
  const flags = require('./featureFlags');
  assert.strictEqual(typeof flags.day1Diagnostic, 'boolean');
  assert.strictEqual(flags.day1Diagnostic, false);
});

test('featureFlags.day1Diagnostic is true when env var is "true"', () => {
  process.env.FEATURE_DAY1_DIAGNOSTIC = 'true';
  delete require.cache[require.resolve('./featureFlags')];
  const flags = require('./featureFlags');
  assert.strictEqual(flags.day1Diagnostic, true);
});

test('featureFlags.day1Diagnostic is false for any string other than "true"', () => {
  for (const v of ['1', 'yes', 'TRUE', 'false', '']) {
    process.env.FEATURE_DAY1_DIAGNOSTIC = v;
    delete require.cache[require.resolve('./featureFlags')];
    const flags = require('./featureFlags');
    assert.strictEqual(flags.day1Diagnostic, false, `expected false for env="${v}"`);
  }
});
