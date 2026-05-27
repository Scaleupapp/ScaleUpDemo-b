'use strict';

require('dotenv').config();
process.env.OPENAI_API_KEY    = process.env.OPENAI_API_KEY    || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('path');

// We need to clear the require cache so we can stub the underlying services
const hooksPath   = path.resolve(__dirname, '../../coding/services/drillGrader/postGradeHooks.js');
const masteryPath = path.resolve(__dirname, '../../coding/services/masteryDelta.js');
const diffPath    = path.resolve(__dirname, '../../coding/services/difficultyRecalibrator.js');

function freshHooks(stubs) {
  // Clear cache
  delete require.cache[hooksPath];
  delete require.cache[masteryPath];
  delete require.cache[diffPath];
  // Install stubs
  require.cache[masteryPath] = { exports: { applyMasteryDelta: stubs.applyMasteryDelta }, loaded: true, id: masteryPath };
  require.cache[diffPath]    = { exports: { recordRecommendation: stubs.recordRecommendation }, loaded: true, id: diffPath };
  return require(hooksPath);
}

test('applyPostGradeUpdates: missing params returns nulls + logs', async () => {
  const { applyPostGradeUpdates } = freshHooks({
    applyMasteryDelta:    async () => ({}),
    recordRecommendation: async () => ({}),
  });
  const r = await applyPostGradeUpdates({ drillAttemptId: null });
  assert.equal(r.mastery, null);
  assert.equal(r.recommendation, null);
});

test('applyPostGradeUpdates: happy path calls both services with correct args', async () => {
  let masteryCalled, recoCalled;
  const { applyPostGradeUpdates } = freshHooks({
    applyMasteryDelta:    async (args) => { masteryCalled = args; return { attempt_count: 1 }; },
    recordRecommendation: async (args) => { recoCalled = args; return { recommended: 'medium' }; },
  });

  const r = await applyPostGradeUpdates({
    drillAttemptId: 'aaa',
    userId:         'bbb',
    roleTrack:      'swe',
    drillSubtype:   'prompt',
    score:          75,
  });

  assert.deepEqual(masteryCalled, { user_id: 'bbb', role_track: 'swe', drill_subtype: 'prompt', score: 75 });
  assert.deepEqual(recoCalled,    { user_id: 'bbb', role_track: 'swe', drillAttemptId: 'aaa' });
  assert.equal(r.mastery.attempt_count, 1);
  assert.equal(r.recommendation.recommended, 'medium');
});

test('applyPostGradeUpdates: mastery failure does NOT block recommendation', async () => {
  let recoCalled = false;
  const { applyPostGradeUpdates } = freshHooks({
    applyMasteryDelta:    async () => { throw new Error('mastery write failed'); },
    recordRecommendation: async () => { recoCalled = true; return { recommended: 'easy' }; },
  });
  const r = await applyPostGradeUpdates({
    drillAttemptId: 'aaa',
    userId:         'bbb',
    roleTrack:      'swe',
    drillSubtype:   'verify',
    score:          60,
  });
  assert.equal(r.mastery, null);
  assert.equal(recoCalled, true);
  assert.equal(r.recommendation.recommended, 'easy');
});

test('applyPostGradeUpdates: both failures return both nulls (does not throw)', async () => {
  const { applyPostGradeUpdates } = freshHooks({
    applyMasteryDelta:    async () => { throw new Error('m'); },
    recordRecommendation: async () => { throw new Error('r'); },
  });
  // Must not throw
  const r = await applyPostGradeUpdates({
    drillAttemptId: 'aaa',
    userId:         'bbb',
    roleTrack:      'swe',
    drillSubtype:   'prompt',
    score:          50,
  });
  assert.equal(r.mastery, null);
  assert.equal(r.recommendation, null);
});
