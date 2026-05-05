const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

test('wave1-topics.json: exists and parses', () => {
  const p = path.join(__dirname, 'wave1-topics.json');
  const raw = fs.readFileSync(p, 'utf8');
  const data = JSON.parse(raw);
  assert.ok(Array.isArray(data), 'must be an array');
  assert.ok(data.length >= 80, `expected ≥80 taxonomy entries, got ${data.length}`);
});

test('wave1-topics.json: every entry has required fields', () => {
  const data = require('./wave1-topics.json');
  for (const entry of data) {
    assert.ok(entry.objectiveType, 'objectiveType required');
    assert.ok(entry.targetKey, `targetKey required for ${entry.objectiveType}`);
    assert.ok(Array.isArray(entry.topics), 'topics array required');
    assert.ok(entry.topics.length >= 3 && entry.topics.length <= 12,
      `topics count out of range: ${entry.topics.length}`);
    for (const t of entry.topics) {
      assert.ok(t.name, 'topic.name required');
      assert.ok(t.canonicalName, 'topic.canonicalName required');
      assert.ok(t.description, 'topic.description required');
      assert.ok(['foundational', 'intermediate', 'advanced'].includes(t.baseDifficulty),
        `bad baseDifficulty: ${t.baseDifficulty}`);
      assert.ok(typeof t.sortOrder === 'number', 'sortOrder required');
    }
  }
});

test('wave1-topics.json: covers all 7 objective types', () => {
  const data = require('./wave1-topics.json');
  const types = new Set(data.map(e => e.objectiveType));
  for (const t of [
    'upskilling', 'interview_preparation', 'exam_preparation',
    'career_switch', 'academic_excellence', 'casual_learning', 'networking',
  ]) {
    assert.ok(types.has(t), `missing objective type: ${t}`);
  }
});

test('wave1-topics.json: includes AI literacy topic for upskilling × PM', () => {
  const data = require('./wave1-topics.json');
  const pmEntry = data.find(e =>
    e.objectiveType === 'upskilling' && e.targetKey === 'upskilling::product-management');
  assert.ok(pmEntry, 'upskilling::product-management entry must exist');
  const aiTopic = pmEntry.topics.find(t => t.isFutureProofing === true);
  assert.ok(aiTopic, 'AI literacy topic (isFutureProofing=true) must exist for PM');
});
