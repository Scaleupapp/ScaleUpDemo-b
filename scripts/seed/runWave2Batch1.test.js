'use strict';

const { test } = require('node:test');
const assert = require('assert');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// JSON data validation
// ---------------------------------------------------------------------------

test('wave2-topics.json: exists and parses as array', () => {
  const p = path.join(__dirname, 'data', 'wave2-topics.json');
  const raw = fs.readFileSync(p, 'utf8');
  const data = JSON.parse(raw);
  assert.ok(Array.isArray(data), 'must be an array');
  assert.ok(data.length >= 10, `expected >=10 entries, got ${data.length}`);
});

test('wave2-topics.json: every entry has required fields', () => {
  const data = require('./data/wave2-topics.json');
  for (const entry of data) {
    assert.ok(entry.objectiveType, 'objectiveType required');
    assert.ok(entry.targetKey, `targetKey required for ${entry.objectiveType}`);
    assert.ok(Array.isArray(entry.topics) && entry.topics.length >= 3,
      `topics array must have >=3 items in ${entry.targetKey}`);
    for (const t of entry.topics) {
      assert.ok(t.name, 'topic.name required');
      assert.ok(t.canonicalName, 'topic.canonicalName required');
      assert.ok(t.description, 'topic.description required');
      assert.ok(
        ['foundational', 'intermediate', 'advanced'].includes(t.baseDifficulty),
        `bad baseDifficulty: ${t.baseDifficulty} in ${entry.targetKey}`
      );
      assert.ok(typeof t.sortOrder === 'number', 'sortOrder must be a number');
    }
  }
});

test('wave2-topics.json: includes required exam_preparation keys', () => {
  const data = require('./data/wave2-topics.json');
  const keys = new Set(data.map(e => e.targetKey));
  const required = [
    'exam_preparation::xat',
    'exam_preparation::nmat',
    'exam_preparation::jee-advanced',
    'exam_preparation::neet-pg',
  ];
  for (const k of required) {
    assert.ok(keys.has(k), `missing required key: ${k}`);
  }
});

test('wave2-topics.json: includes required career_switch keys', () => {
  const data = require('./data/wave2-topics.json');
  const keys = new Set(data.map(e => e.targetKey));
  const required = [
    'career_switch::data-analyst::ml-engineer',
    'career_switch::defense::corporate',
  ];
  for (const k of required) {
    assert.ok(keys.has(k), `missing required key: ${k}`);
  }
});

// ---------------------------------------------------------------------------
// Orchestrator script smoke test
// ---------------------------------------------------------------------------

test('runWave2Batch1: module exports runWave2Batch1 function', () => {
  const mod = require('./runWave2Batch1');
  assert.strictEqual(typeof mod.runWave2Batch1, 'function');
});
