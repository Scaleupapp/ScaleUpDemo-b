const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

function setupStubs({ existingProfile = null } = {}) {
  const dapath = require.resolve('../models/DiagnosticAttempt');
  let saved = null;
  require.cache[dapath] = {
    exports: function FakeDA(data) {
      Object.assign(this, data);
      this.save = async () => { saved = this; this._id = new mongoose.Types.ObjectId(); return this; };
    },
    loaded: true, id: dapath,
  };
  // Helpers attached to the constructor
  require.cache[dapath].exports.findOne = async () => null;

  const kppath = require.resolve('../models/KnowledgeProfile');
  require.cache[kppath] = {
    exports: { findOne: async () => existingProfile },
    loaded: true, id: kppath,
  };

  const objpath = require.resolve('../models/UserObjective');
  require.cache[objpath] = {
    exports: { findOne: () => ({ lean: async () => ({
      _id: 'obj1',
      objectiveType: 'interview_preparation',
      analysis: { competencies: [
        { name: 'system design' }, { name: 'sql' }, { name: 'roadmapping' },
      ] },
    }) }) },
    loaded: true, id: objpath,
  };

  // Stub pool service so diagnosticService loads without OPENAI_API_KEY
  const poolPath = require.resolve('./diagnosticPoolService');
  require.cache[poolPath] = {
    exports: {
      assemblePool: async () => [],
      _internal: { calculatePoolAllocation: () => [] },
    },
    loaded: true, id: poolPath,
  };

  delete require.cache[require.resolve('./diagnosticService')];
  const svc = require('./diagnosticService');
  return { svc, getSaved: () => saved };
}

test('startAttempt creates a new_user attempt with linked competencies', async () => {
  const { svc, getSaved } = setupStubs();
  const userId = new mongoose.Types.ObjectId();
  const result = await svc.startAttempt(userId);
  const saved = getSaved();
  assert.ok(saved);
  assert.strictEqual(saved.flowType, 'new_user');
  assert.strictEqual(saved.status, 'in_progress');
  assert.deepStrictEqual(result.competenciesToAssess.map(c => c.name).sort(), ['roadmapping', 'sql', 'system design']);
});

test('startAttempt creates an existing_user_tune attempt when KnowledgeProfile has activity', async () => {
  const { svc } = setupStubs({
    existingProfile: { totalQuizzesTaken: 5, topicMastery: [
      { topic: 'sql', score: 80, quizzesTaken: 5, scoreHistory: [
        { score: 78 }, { score: 82 }, { score: 80 }, { score: 79 }, { score: 81 },
      ] },
    ] },
  });
  const userId = new mongoose.Types.ObjectId();
  const result = await svc.startAttempt(userId);
  assert.strictEqual(result.flowType, 'existing_user_tune');
});

test('startAttempt returns null when objective has no competencies (caller falls back)', async () => {
  const objpath = require.resolve('../models/UserObjective');
  require.cache[objpath] = {
    exports: { findOne: () => ({ lean: async () => ({ _id: 'obj1', analysis: { competencies: [] } }) }) },
    loaded: true, id: objpath,
  };
  delete require.cache[require.resolve('./diagnosticService')];
  const svc = require('./diagnosticService');
  const result = await svc.startAttempt(new mongoose.Types.ObjectId());
  assert.strictEqual(result, null);
});

test('submitSelfRating stores ratings on the attempt', async () => {
  const dapath = require.resolve('../models/DiagnosticAttempt');
  let savedAttempt = null;
  const fakeAttempt = {
    _id: new mongoose.Types.ObjectId(),
    selfRatings: new Map(),
    poolQuestionIds: [],
    save: async function () { savedAttempt = this; return this; },
  };
  require.cache[dapath] = {
    exports: { findById: async () => fakeAttempt },
    loaded: true, id: dapath,
  };
  // Stub pool service to return a small pool
  const poolPath = require.resolve('./diagnosticPoolService');
  require.cache[poolPath] = {
    exports: {
      assemblePool: async () => [{ _id: 'q1' }, { _id: 'q2' }],
      _internal: {
        calculatePoolAllocation: () => [{ name: 'sql', easy: 1, medium: 1, hard: 0 }],
      },
    },
    loaded: true, id: poolPath,
  };

  delete require.cache[require.resolve('./diagnosticService')];
  const svc = require('./diagnosticService');
  await svc.submitSelfRating(fakeAttempt._id, { sql: 'familiar' });
  assert.strictEqual(savedAttempt.selfRatings.get('sql'), 'familiar');
  assert.strictEqual(savedAttempt.poolQuestionIds.length, 2);
});
