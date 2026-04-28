const test = require('node:test');
const assert = require('node:assert');
const { normalize, _internal } = require('./competencyNormalizer');

test('normalize lowercases and trims whitespace', () => {
  assert.strictEqual(normalize('  System Design  '), 'system design');
});

test('normalize strips punctuation', () => {
  assert.strictEqual(normalize('System Design!'), 'system design');
  assert.strictEqual(normalize('SQL.Joins'), 'database joins');
});

test('normalize collapses repeated whitespace', () => {
  assert.strictEqual(normalize('system   design'), 'system design');
});

test('normalize resolves common aliases via dictionary', () => {
  // These are wired up in the dictionary
  assert.strictEqual(normalize('sql joins'), 'database joins');
  assert.strictEqual(normalize('joins'), 'database joins');
  assert.strictEqual(normalize('product market fit'), 'product-market fit');
});

test('normalize returns empty string for empty/null input', () => {
  assert.strictEqual(normalize(''), '');
  assert.strictEqual(normalize(null), '');
  assert.strictEqual(normalize(undefined), '');
});

test('_internal exposes the alias dictionary for tests', () => {
  assert.ok(_internal.aliasDictionary);
  assert.strictEqual(typeof _internal.aliasDictionary, 'object');
});
