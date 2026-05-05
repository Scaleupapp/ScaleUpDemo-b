const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

const taxonomyPath = require.resolve('../../src/models/TopicTaxonomy');
const writes = [];

require.cache[taxonomyPath] = {
  exports: Object.assign(
    function FakeTaxonomy(data) {
      Object.assign(this, data);
      this._id = new mongoose.Types.ObjectId();
      this.save = async () => { writes.push({ ...this }); return this; };
    },
    {
      OBJECTIVE_TYPES: [
        'upskilling', 'interview_preparation', 'exam_preparation',
        'career_switch', 'academic_excellence', 'casual_learning', 'networking',
      ],
      DIFFICULTIES: ['foundational', 'intermediate', 'advanced'],
      bulkWrite: async (ops) => {
        for (const op of ops) {
          writes.push(op.replaceOne ? op.replaceOne.replacement : op);
        }
        return { upsertedCount: ops.length };
      },
    }
  ),
  loaded: true, id: taxonomyPath,
};

delete require.cache[require.resolve('./seedTopicTaxonomy')];
const { seedFromData } = require('./seedTopicTaxonomy');

test('seedFromData: writes one upsert per entry', async () => {
  writes.length = 0;
  const data = [
    {
      objectiveType: 'upskilling',
      targetKey: 'upskilling::pm',
      source: 'curated',
      topics: [{ name: 'X', canonicalName: 'x', description: 'd', baseDifficulty: 'intermediate', sortOrder: 1 }],
    },
    {
      objectiveType: 'exam_preparation',
      targetKey: 'exam_preparation::cat',
      source: 'curated',
      topics: [{ name: 'Quant', canonicalName: 'quant', description: 'd', baseDifficulty: 'advanced', sortOrder: 1 }],
    },
  ];
  const result = await seedFromData(data, { dryRun: false });
  assert.strictEqual(result.upserted, 2);
  assert.strictEqual(writes.length, 2);
});

test('seedFromData: dryRun does not write', async () => {
  writes.length = 0;
  const result = await seedFromData([
    {
      objectiveType: 'upskilling',
      targetKey: 'upskilling::pm',
      source: 'curated',
      topics: [{ name: 'X', canonicalName: 'x', description: 'd', baseDifficulty: 'intermediate', sortOrder: 1 }],
    },
  ], { dryRun: true });
  assert.strictEqual(result.upserted, 1);
  assert.strictEqual(writes.length, 0);
});

test('seedFromData: rejects entry with invalid objectiveType', async () => {
  await assert.rejects(
    seedFromData([{ objectiveType: 'invalid', targetKey: 'x', source: 'curated', topics: [] }]),
    /invalid objectiveType/i
  );
});
