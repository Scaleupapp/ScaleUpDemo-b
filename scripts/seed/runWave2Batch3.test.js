'use strict';

const { test } = require('node:test');
const assert = require('assert');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Finance exam JSON validation
// ---------------------------------------------------------------------------

test('wave2-finance-exams.json: exists and parses as array', () => {
  const p = path.join(__dirname, 'data', 'wave2-finance-exams.json');
  const raw = fs.readFileSync(p, 'utf8');
  const data = JSON.parse(raw);
  assert.ok(Array.isArray(data), 'must be an array');
  assert.ok(data.length >= 5, `expected >=5 entries, got ${data.length}`);
});

test('wave2-finance-exams.json: every entry has required fields', () => {
  const data = require('./data/wave2-finance-exams.json');
  for (const entry of data) {
    assert.ok(entry.objectiveType, 'objectiveType required');
    assert.ok(entry.targetKey, 'targetKey required');
    assert.ok(Array.isArray(entry.topics) && entry.topics.length >= 3,
      `topics must have >=3 items in ${entry.targetKey}`);
    for (const t of entry.topics) {
      assert.ok(t.name, 'topic.name required');
      assert.ok(t.canonicalName, 'topic.canonicalName required');
      assert.ok(
        ['foundational', 'intermediate', 'advanced'].includes(t.baseDifficulty),
        `bad baseDifficulty in ${entry.targetKey}`
      );
    }
  }
});

test('wave2-finance-exams.json: includes required exam keys', () => {
  const data = require('./data/wave2-finance-exams.json');
  const keys = new Set(data.map(e => e.targetKey));
  const required = [
    'exam_preparation::cfa-l2',
    'exam_preparation::cfa-l3',
    'exam_preparation::frm-part-1',
    'exam_preparation::ibps-clerk',
    'exam_preparation::rbi-grade-b',
  ];
  for (const k of required) {
    assert.ok(keys.has(k), `missing required key: ${k}`);
  }
});

// ---------------------------------------------------------------------------
// Finance companies JSON validation
// ---------------------------------------------------------------------------

test('wave2-companies.json: exists and parses as array', () => {
  const p = path.join(__dirname, 'data', 'wave2-companies.json');
  const raw = fs.readFileSync(p, 'utf8');
  const data = JSON.parse(raw);
  assert.ok(Array.isArray(data), 'must be an array');
  assert.ok(data.length >= 5, `expected >=5 company entries, got ${data.length}`);
});

test('wave2-companies.json: every profile has required fields', () => {
  const data = require('./data/wave2-companies.json');
  for (const c of data) {
    assert.ok(c.name, 'name required');
    assert.ok(c.normalizedName, 'normalizedName required');
    assert.ok(c.industry, 'industry required');
    assert.ok(Array.isArray(c.applicableObjectives) && c.applicableObjectives.length > 0,
      'applicableObjectives required');
    assert.ok(Array.isArray(c.signatureInterviewElements) && c.signatureInterviewElements.length > 0,
      'signatureInterviewElements required');
    assert.ok(c.examplesContext, 'examplesContext required');
    assert.strictEqual(c.source, 'curated', `source must be curated for ${c.normalizedName}`);
  }
});

// ---------------------------------------------------------------------------
// Orchestrator script smoke test
// ---------------------------------------------------------------------------

test('runWave2Batch3: module exports runWave2Batch3 function', () => {
  const mod = require('./runWave2Batch3');
  assert.strictEqual(typeof mod.runWave2Batch3, 'function');
});
