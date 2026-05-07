'use strict';

const { test } = require('node:test');
const assert = require('assert');

const { parseTargetKey, runGapFillBatch } = require('./runGapFillBatch');

// ---------------------------------------------------------------------------
// parseTargetKey
// ---------------------------------------------------------------------------

test('parseTargetKey: splits objectiveType from single specifics', () => {
  const result = parseTargetKey('exam_preparation::xat');
  assert.strictEqual(result.objectiveType, 'exam_preparation');
  assert.deepStrictEqual(result.specifics, ['xat']);
});

test('parseTargetKey: splits objectiveType from multiple specifics', () => {
  const result = parseTargetKey('career_switch::data-analyst::ml-engineer');
  assert.strictEqual(result.objectiveType, 'career_switch');
  assert.deepStrictEqual(result.specifics, ['data-analyst', 'ml-engineer']);
});

test('parseTargetKey: handles academic_excellence multi-part key', () => {
  const result = parseTargetKey('academic_excellence::msbshse::12::physics');
  assert.strictEqual(result.objectiveType, 'academic_excellence');
  assert.deepStrictEqual(result.specifics, ['msbshse', '12', 'physics']);
});

test('parseTargetKey: throws on missing separator', () => {
  assert.throws(
    () => parseTargetKey('exam_preparation'),
    /Invalid canonicalTarget/
  );
});

// ---------------------------------------------------------------------------
// runGapFillBatch presence check
// ---------------------------------------------------------------------------

test('runGapFillBatch: exported as a function', () => {
  assert.strictEqual(typeof runGapFillBatch, 'function');
});

test('runGapFillBatch: throws on empty targets array', async () => {
  await assert.rejects(
    () => runGapFillBatch([]),
    /targets must be a non-empty array/
  );
});
