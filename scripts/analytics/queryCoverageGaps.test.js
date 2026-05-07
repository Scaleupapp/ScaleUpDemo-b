'use strict';

const { test } = require('node:test');
const assert = require('assert');

const { rankGaps, buildReport } = require('./queryCoverageGaps');

// ---------------------------------------------------------------------------
// rankGaps
// ---------------------------------------------------------------------------

test('rankGaps: returns empty array for no events', () => {
  const result = rankGaps([]);
  assert.deepStrictEqual(result, []);
});

test('rankGaps: counts events by target_key and sorts descending', () => {
  const events = [
    { properties: { target_key: 'exam_preparation::xat' } },
    { properties: { target_key: 'exam_preparation::xat' } },
    { properties: { target_key: 'career_switch::data-analyst::ml-engineer' } },
    { properties: { target_key: 'exam_preparation::xat' } },
  ];
  const result = rankGaps(events);
  assert.strictEqual(result[0].targetKey, 'exam_preparation::xat');
  assert.strictEqual(result[0].hitCount, 3);
  assert.strictEqual(result[1].targetKey, 'career_switch::data-analyst::ml-engineer');
  assert.strictEqual(result[1].hitCount, 1);
});

test('rankGaps: respects topN limit', () => {
  const events = Array.from({ length: 10 }, (_, i) => ({
    properties: { target_key: `key_${i}` },
  }));
  const result = rankGaps(events, 3);
  assert.strictEqual(result.length, 3);
});

test('rankGaps: assigns unknown for events without target_key', () => {
  const events = [{ properties: {} }, { properties: {} }];
  const result = rankGaps(events);
  assert.strictEqual(result[0].targetKey, 'unknown');
  assert.strictEqual(result[0].hitCount, 2);
});

// ---------------------------------------------------------------------------
// buildReport
// ---------------------------------------------------------------------------

test('buildReport: produces valid markdown with rank table', () => {
  const gaps = [
    { targetKey: 'exam_preparation::xat', hitCount: 42 },
    { targetKey: 'career_switch::defense::corporate', hitCount: 17 },
  ];
  const report = buildReport(gaps, '2026-04-01', '2026-05-01');
  assert.ok(report.includes('exam_preparation::xat'), 'must include first targetKey');
  assert.ok(report.includes('42'), 'must include hit count');
  assert.ok(report.includes('| Rank |'), 'must include table header');
});
