const test = require('node:test');
const assert = require('node:assert');

const userObjPath = require.resolve('../models/UserObjective');
require.cache[userObjPath] = {
  exports: {
    find: () => ({ lean: async () => [
      { objectiveType: 'upskilling', specificsCanonical: { targetSkill: 'rust-systems' } },
      { objectiveType: 'upskilling', specificsCanonical: { targetSkill: 'rust-systems' } },
      { objectiveType: 'upskilling', specificsCanonical: { targetSkill: 'product-management' } },
    ] }),
  },
  loaded: true, id: userObjPath,
};

const taxPath = require.resolve('../models/TopicTaxonomy');
const knownTargets = new Set(['upskilling::product-management']);
require.cache[taxPath] = {
  exports: {
    find: () => ({ lean: async () => [...knownTargets].map(t => ({ targetKey: t })) }),
    findOne: ({ targetKey }) => ({ lean: async () => knownTargets.has(targetKey) ? { targetKey } : null }),
  },
  loaded: true, id: taxPath,
};

delete require.cache[require.resolve('./dailyTaxonomyRefresh')];
const { findNewTargetKeys } = require('./dailyTaxonomyRefresh');

test('findNewTargetKeys: returns target keys present in user objectives but missing in taxonomy', async () => {
  const newKeys = await findNewTargetKeys();
  assert.ok(newKeys.includes('upskilling::rust-systems'));
  assert.ok(!newKeys.includes('upskilling::product-management'));
});
