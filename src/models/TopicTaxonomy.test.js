const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

// Force fresh module load
delete require.cache[require.resolve('./TopicTaxonomy')];
const TopicTaxonomy = require('./TopicTaxonomy');

test('TopicTaxonomy: creates with required fields', () => {
  const doc = new TopicTaxonomy({
    objectiveType: 'upskilling',
    targetKey: 'upskilling::product-management',
    topics: [
      {
        name: 'Product Strategy',
        canonicalName: 'product-strategy',
        description: 'Defining product vision and prioritising bets.',
        baseDifficulty: 'intermediate',
        isFutureProofing: false,
        sortOrder: 1,
      },
    ],
    source: 'curated',
  });
  const err = doc.validateSync();
  assert.strictEqual(err, undefined, 'should validate cleanly');
  assert.strictEqual(doc.topics.length, 1);
  assert.strictEqual(doc.refreshCount, 0, 'refreshCount defaults to 0');
});

test('TopicTaxonomy: requires objectiveType', () => {
  const doc = new TopicTaxonomy({ targetKey: 'x', topics: [] });
  const err = doc.validateSync();
  assert.ok(err && err.errors.objectiveType, 'objectiveType required');
});

test('TopicTaxonomy: rejects invalid objectiveType enum', () => {
  const doc = new TopicTaxonomy({
    objectiveType: 'not_a_real_type',
    targetKey: 'x',
    topics: [],
    source: 'curated',
  });
  const err = doc.validateSync();
  assert.ok(err && err.errors.objectiveType, 'invalid enum should error');
});

test('TopicTaxonomy: rejects invalid baseDifficulty in topic', () => {
  const doc = new TopicTaxonomy({
    objectiveType: 'upskilling',
    targetKey: 'x',
    topics: [{
      name: 'X',
      canonicalName: 'x',
      description: 'd',
      baseDifficulty: 'super_hard',
      sortOrder: 1,
    }],
    source: 'curated',
  });
  const err = doc.validateSync();
  assert.ok(err, 'invalid difficulty should error');
});
