const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

const cpPath = require.resolve('../../src/models/CompanyProfile');
const writes = [];
require.cache[cpPath] = {
  exports: Object.assign(
    function FakeCP(data) { Object.assign(this, data); },
    {
      bulkWrite: async (ops) => {
        for (const op of ops) writes.push(op.replaceOne.replacement);
        return { upsertedCount: ops.length };
      },
    }
  ),
  loaded: true, id: cpPath,
};

delete require.cache[require.resolve('./seedCompanyProfiles')];
const { seedCompaniesFromData } = require('./seedCompanyProfiles');

test('seedCompaniesFromData: writes one upsert per profile', async () => {
  writes.length = 0;
  const result = await seedCompaniesFromData([
    {
      name: 'Razorpay', normalizedName: 'razorpay', industry: 'Fintech',
      applicableObjectives: ['interview_preparation'],
      signatureInterviewElements: ['x'], examplesContext: 'y', source: 'curated',
    },
  ]);
  assert.strictEqual(result.upserted, 1);
  assert.strictEqual(writes.length, 1);
});

test('seedCompaniesFromData: rejects missing normalizedName', async () => {
  await assert.rejects(
    seedCompaniesFromData([{ name: 'X', industry: 'T', source: 'curated' }]),
    /normalizedName/i
  );
});

test('seedCompaniesFromData: dryRun does not write', async () => {
  writes.length = 0;
  const result = await seedCompaniesFromData([
    {
      name: 'X', normalizedName: 'x', industry: 'T',
      applicableObjectives: ['upskilling'], signatureInterviewElements: ['s'],
      examplesContext: 'c', source: 'curated',
    },
  ], { dryRun: true });
  assert.strictEqual(result.upserted, 1);
  assert.strictEqual(writes.length, 0);
});
