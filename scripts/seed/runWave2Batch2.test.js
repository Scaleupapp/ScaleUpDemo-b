'use strict';

const { test } = require('node:test');
const assert = require('assert');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// JSON data validation
// ---------------------------------------------------------------------------

test('wave2-state-boards.json: exists and parses as array', () => {
  const p = path.join(__dirname, 'data', 'wave2-state-boards.json');
  const raw = fs.readFileSync(p, 'utf8');
  const data = JSON.parse(raw);
  assert.ok(Array.isArray(data), 'must be an array');
  assert.ok(data.length >= 8, `expected >=8 entries, got ${data.length}`);
});

test('wave2-state-boards.json: every entry has required fields', () => {
  const data = require('./data/wave2-state-boards.json');
  for (const entry of data) {
    assert.ok(entry.objectiveType, 'objectiveType required');
    assert.ok(entry.targetKey, `targetKey required`);
    assert.strictEqual(entry.objectiveType, 'academic_excellence',
      `all state board entries must use academic_excellence: ${entry.targetKey}`);
    assert.ok(Array.isArray(entry.topics) && entry.topics.length >= 3,
      `topics must have >=3 items in ${entry.targetKey}`);
    for (const t of entry.topics) {
      assert.ok(t.name, 'topic.name required');
      assert.ok(t.canonicalName, 'topic.canonicalName required');
      assert.ok(t.description, 'topic.description required');
      assert.ok(
        ['foundational', 'intermediate', 'advanced'].includes(t.baseDifficulty),
        `bad baseDifficulty: ${t.baseDifficulty} in ${entry.targetKey}`
      );
    }
  }
});

test('wave2-state-boards.json: includes msbshse entries', () => {
  const data = require('./data/wave2-state-boards.json');
  const keys = data.map(e => e.targetKey);
  const msbshseEntries = keys.filter(k => k.includes('msbshse'));
  assert.ok(msbshseEntries.length >= 1, `expected >=1 msbshse entry, got ${msbshseEntries.length}`);
});

test('wave2-state-boards.json: includes tn-state-board entries', () => {
  const data = require('./data/wave2-state-boards.json');
  const keys = data.map(e => e.targetKey);
  const tnEntries = keys.filter(k => k.includes('tn-state-board'));
  assert.ok(tnEntries.length >= 1, `expected >=1 tn-state-board entry, got ${tnEntries.length}`);
});

test('wave2-state-boards.json: includes kseeb entries', () => {
  const data = require('./data/wave2-state-boards.json');
  const keys = data.map(e => e.targetKey);
  const kseebEntries = keys.filter(k => k.includes('kseeb'));
  assert.ok(kseebEntries.length >= 1, `expected >=1 kseeb entry, got ${kseebEntries.length}`);
});

// ---------------------------------------------------------------------------
// Orchestrator script smoke test
// ---------------------------------------------------------------------------

test('runWave2Batch2: module exports runWave2Batch2 function', () => {
  const mod = require('./runWave2Batch2');
  assert.strictEqual(typeof mod.runWave2Batch2, 'function');
});
