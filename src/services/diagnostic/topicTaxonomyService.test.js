const test = require('node:test');
const assert = require('node:assert');

delete require.cache[require.resolve('./topicTaxonomyService')];
const svc = require('./topicTaxonomyService');

test('buildTargetKey: upskilling with targetSkill', () => {
  const key = svc.buildTargetKey('upskilling', { targetSkill: 'Product Management' });
  assert.strictEqual(key, 'upskilling::product-management');
});

test('buildTargetKey: interview_preparation with targetRole + targetCompany tier', () => {
  const key = svc.buildTargetKey('interview_preparation', {
    targetRole: 'Software Engineer',
    targetCompany: 'FAANG',
  });
  assert.strictEqual(key, 'interview_preparation::software-engineer::faang');
});

test('buildTargetKey: exam_preparation with examName', () => {
  const key = svc.buildTargetKey('exam_preparation', { examName: 'JEE Main' });
  assert.strictEqual(key, 'exam_preparation::jee-main');
});

test('buildTargetKey: career_switch with from + to domains', () => {
  const key = svc.buildTargetKey('career_switch', {
    fromDomain: 'Investment Banking',
    toDomain: 'Product Management',
  });
  assert.strictEqual(key, 'career_switch::investment-banking::product-management');
});

test('buildTargetKey: academic_excellence with board + grade + subject', () => {
  const key = svc.buildTargetKey('academic_excellence', {
    board: 'CBSE',
    grade: '12',
    subject: 'Physics',
  });
  assert.strictEqual(key, 'academic_excellence::cbse::12::physics');
});

test('buildTargetKey: casual_learning falls back to generic', () => {
  const key = svc.buildTargetKey('casual_learning', {});
  assert.strictEqual(key, 'casual_learning::general');
});

test('canonicalize: lowercases and dasherizes', () => {
  assert.strictEqual(svc.canonicalize('Product Management'), 'product-management');
  assert.strictEqual(svc.canonicalize('JEE Main'), 'jee-main');
  assert.strictEqual(svc.canonicalize('  IT  Services  '), 'it-services');
  assert.strictEqual(svc.canonicalize('A&B/C'), 'a-b-c');
  assert.strictEqual(svc.canonicalize(''), '');
});

// ---------------------------------------------------------------------------
// generateTaxonomyForTargetKey tests
// ---------------------------------------------------------------------------

{
  const openaiPath = require.resolve('../../config/openai');
  require.cache[openaiPath] = {
    exports: {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: JSON.stringify({
              topics: [
                { name: 'Topic One', canonicalName: 'topic-one', description: 'desc one here', baseDifficulty: 'foundational', isFutureProofing: false, sortOrder: 1 },
                { name: 'Topic Two', canonicalName: 'topic-two', description: 'desc two here', baseDifficulty: 'intermediate', isFutureProofing: false, sortOrder: 2 },
                { name: 'Topic Three', canonicalName: 'topic-three', description: 'desc three here', baseDifficulty: 'intermediate', isFutureProofing: false, sortOrder: 3 },
                { name: 'Topic Four', canonicalName: 'topic-four', description: 'desc four here', baseDifficulty: 'advanced', isFutureProofing: false, sortOrder: 4 },
              ],
            }) } }],
          }),
        },
      },
    },
    loaded: true, id: openaiPath,
  };

  const taxonomyPath = require.resolve('../../models/TopicTaxonomy');
  let createdDoc = null;
  require.cache[taxonomyPath] = {
    exports: {
      findOne: async () => null,
      create: async (data) => { createdDoc = data; return { _id: 'fake-id', ...data }; },
    },
    loaded: true, id: taxonomyPath,
  };

  delete require.cache[require.resolve('./topicTaxonomyService')];
  const svc2 = require('./topicTaxonomyService');

  test('generateTaxonomyForTargetKey: parses LLM response and persists taxonomy', async () => {
    createdDoc = null;
    const result = await svc2.generateTaxonomyForTargetKey('exam_preparation::cma-final');
    assert.ok(result);
    assert.strictEqual(result.objectiveType, 'exam_preparation');
    assert.strictEqual(result.targetKey, 'exam_preparation::cma-final');
    assert.strictEqual(result.source, 'llm-generated');
    assert.strictEqual(result.topics.length, 4);
    assert.strictEqual(result.topics[0].canonicalName, 'topic-one');
    assert.ok(createdDoc, 'Taxonomy.create was called');
  });

  test('generateTaxonomyForTargetKey: rejects malformed targetKey', async () => {
    await assert.rejects(
      () => svc2.generateTaxonomyForTargetKey('bad-key-no-double-colon'),
      /invalid targetKey/i
    );
  });

  test('generateTaxonomyForTargetKey: returns existing taxonomy if already present', async () => {
    require.cache[taxonomyPath].exports.findOne = async () => ({
      _id: 'existing-id',
      objectiveType: 'exam_preparation',
      targetKey: 'exam_preparation::cma-final',
      topics: [{ canonicalName: 'existing' }],
      source: 'curated',
    });
    delete require.cache[require.resolve('./topicTaxonomyService')];
    const svc3 = require('./topicTaxonomyService');
    const result = await svc3.generateTaxonomyForTargetKey('exam_preparation::cma-final');
    assert.strictEqual(result._id, 'existing-id');
    assert.strictEqual(result.source, 'curated');
  });
}
