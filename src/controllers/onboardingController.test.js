const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const CONTROLLER_PATH = path.resolve(__dirname, './onboardingController.js');

function buildReqRes({ body = {}, params = {}, user = { _id: 'u1' } } = {}) {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return [{ body, params, user }, res];
}

// Stub the TopicTaxonomy model so we don't hit Mongo.
function stubModel(modelRelPath, stub) {
  const abs = require.resolve(path.resolve(__dirname, '..', 'models', modelRelPath));
  delete require.cache[abs];
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: stub };
}

function loadController() {
  delete require.cache[CONTROLLER_PATH];
  return require(CONTROLLER_PATH);
}

test('suggestTopics: returns 400 when objectiveType missing', async () => {
  stubModel('TopicTaxonomy', { findOne: async () => null });
  const ctrl = loadController();
  const [req, res] = buildReqRes({ body: { specifics: {} } });
  await ctrl.suggestTopics(req, res);
  assert.strictEqual(res.statusCode, 400);
});

test('suggestTopics: returns 404 with TAXONOMY_MISSING when no entry', async () => {
  stubModel('TopicTaxonomy', { findOne: async () => null });
  const ctrl = loadController();
  const [req, res] = buildReqRes({
    body: { objectiveType: 'upskilling', specifics: { targetSkill: 'Product Management' } },
  });
  await ctrl.suggestTopics(req, res);
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(res.body.code, 'TAXONOMY_MISSING');
});

function stubService(relPath, stub) {
  const abs = require.resolve(path.resolve(__dirname, '..', 'services', relPath));
  delete require.cache[abs];
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: stub };
}

test('suggestTopics: returns topics when taxonomy exists', async () => {
  const fakeTopics = [
    { name: 'Product Strategy', canonicalName: 'product-strategy', description: 'd', baseDifficulty: 'intermediate', isFutureProofing: false, sortOrder: 1 },
    { name: 'AI for PMs', canonicalName: 'ai-for-pms', description: 'd', baseDifficulty: 'foundational', isFutureProofing: true, sortOrder: 2 },
  ];
  stubModel('TopicTaxonomy', {
    findOne: async ({ objectiveType, targetKey }) => {
      assert.strictEqual(objectiveType, 'upskilling');
      assert.ok(targetKey.startsWith('upskilling::'));
      return { topics: fakeTopics, source: 'curated' };
    },
  });
  const ctrl = loadController();
  const [req, res] = buildReqRes({
    body: { objectiveType: 'upskilling', specifics: { targetSkill: 'Product Management' } },
  });
  await ctrl.suggestTopics(req, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.topics.length, 2);
  assert.strictEqual(res.body.source, 'curated');
});

test('completeOnboarding: 400 when required fields missing', async () => {
  stubModel('UserObjective', class {});
  stubService('diagnostic/specificsNormalizationService', { normalizeSpecifics: async () => ({}) });
  const ctrl = loadController();
  const [req, res] = buildReqRes({ body: { objectiveType: 'upskilling' } });
  await ctrl.completeOnboarding(req, res);
  assert.strictEqual(res.statusCode, 400);
});

test('completeOnboarding: persists, normalizes, returns userObjectiveId', async () => {
  let captured = null;

  // Fake UserObjective acts like a Mongoose model: `findOneAndUpdate` returns a plain doc.
  const FakeUO = {
    findOneAndUpdate: async (filter, update, opts) => {
      captured = { filter, update, opts };
      return { _id: 'objective-id-xyz', ...update.$set };
    },
  };
  stubModel('UserObjective', FakeUO);
  stubService('diagnostic/specificsNormalizationService', {
    normalizeSpecifics: async ({ specifics }) => {
      // Returns canonical version.
      return { ...specifics, examName: specifics.examName ? 'JEE Advanced' : undefined };
    },
  });

  const ctrl = loadController();
  const [req, res] = buildReqRes({
    user: { _id: 'user-1' },
    body: {
      objectiveType: 'exam_preparation',
      timeline: '6_months',
      currentLevel: 'beginner',
      weeklyCommitHours: 8,
      topicsOfInterest: ['mechanics', 'thermodynamics'],
      topicSelfRatings: { mechanics: 'familiar', thermodynamics: 'novice' },
      specifics: { examName: 'jee' },
    },
  });
  await ctrl.completeOnboarding(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.userObjectiveId, 'objective-id-xyz');
  assert.strictEqual(captured.filter.userId, 'user-1');
  assert.strictEqual(captured.update.$set.specificsCanonical.examName, 'JEE Advanced');
  assert.strictEqual(captured.update.$set.topicSelfRatings.mechanics, 'familiar');
  assert.strictEqual(captured.update.$set.needsCalibration, false);
});

test('completeOnboarding: still saves even if normalization throws', async () => {
  const FakeUO = {
    findOneAndUpdate: async (_f, update) => ({ _id: 'oid', ...update.$set }),
  };
  stubModel('UserObjective', FakeUO);
  stubService('diagnostic/specificsNormalizationService', {
    normalizeSpecifics: async () => { throw new Error('llm down'); },
  });
  const ctrl = loadController();
  const [req, res] = buildReqRes({
    user: { _id: 'user-1' },
    body: {
      objectiveType: 'upskilling',
      timeline: '3_months',
      currentLevel: 'intermediate',
      weeklyCommitHours: 6,
      topicsOfInterest: ['x'],
      topicSelfRatings: { x: 'novice' },
      specifics: { targetSkill: 'PM' },
    },
  });
  await ctrl.completeOnboarding(req, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.userObjectiveId, 'oid');
});

test('completeOnboarding: marks User.onboardingComplete = true', async () => {
  let userUpdated = null;
  const FakeUO = {
    findOneAndUpdate: async (_f, update) => ({ _id: 'oid', ...update.$set }),
  };
  const FakeUser = {
    findByIdAndUpdate: async (id, update) => {
      userUpdated = { id, update };
      return { _id: id, ...update };
    },
  };
  stubModel('UserObjective', FakeUO);
  stubModel('User', FakeUser);
  stubService('diagnostic/specificsNormalizationService', {
    normalizeSpecifics: async () => ({}),
  });

  const ctrl = loadController();
  const [req, res] = buildReqRes({
    user: { _id: 'user-1' },
    body: {
      objectiveType: 'upskilling',
      timeline: '3_months',
      currentLevel: 'beginner',
      weeklyCommitHours: 5,
      topicsOfInterest: ['x'],
      topicSelfRatings: { x: 'novice' },
      specifics: {},
    },
  });
  await ctrl.completeOnboarding(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.ok(userUpdated, 'User.findByIdAndUpdate should have been called');
  assert.strictEqual(userUpdated.id, 'user-1');
  assert.strictEqual(userUpdated.update.onboardingComplete, true);
  assert.strictEqual(userUpdated.update.onboardingStep, 5);
});
