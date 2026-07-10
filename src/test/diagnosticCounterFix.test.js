'use strict';
/**
 * Workstream C — "Question 38 of 24" fix.
 *
 * Verifies nextQuestion() caps the served count at the planned total, that the
 * progress counter reports the plan (not the assembled pool size), the legacy
 * poolQuestionIds fallback, and that the pool is frozen once answers exist
 * (never re-assembled mid-attempt). All stubs via require.cache — no DB.
 */
const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

// Heavy deps stubbed at module level so diagnosticService loads without Redis/OpenAI.
const queuePath = require.resolve('../config/queue');
require.cache[queuePath] = { exports: { planGenerationQueue: { add: async () => ({}) } }, loaded: true, id: queuePath };
const openaiPath = require.resolve('../config/openai');
require.cache[openaiPath] = { exports: { chat: { completions: { create: async () => ({ choices: [] }) } } }, loaded: true, id: openaiPath };

function qDoc(id) {
  return {
    _id: id, canonicalCompetency: 'sql', difficulty: 'medium',
    questionText: 'Q?', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }],
    correctAnswer: 'A', requiresVoice: false,
  };
}

// Load a fresh diagnosticService with the given attempt doc + bank rehydrate result.
// assemblePool is a spy that records if it was ever called (it must NOT be, once
// an attempt has answers — that's the freeze guarantee).
function loadWith({ attempt, bankQuestions = [] }) {
  const state = { assembleCalled: false };

  const daPath = require.resolve('../models/DiagnosticAttempt');
  const bankPath = require.resolve('../models/DiagnosticQuestionBank');
  const taxPath = require.resolve('../models/TopicTaxonomy');
  const uoPath = require.resolve('../models/UserObjective');
  const poolPath = require.resolve('../services/diagnosticPoolService');
  const svcPath = require.resolve('../services/diagnosticService');

  const orig = {};
  for (const p of [daPath, bankPath, taxPath, uoPath, poolPath, svcPath]) orig[p] = require.cache[p];

  require.cache[daPath] = { exports: { findById: async () => attempt }, loaded: true, id: daPath };
  require.cache[bankPath] = {
    exports: {
      find: () => ({ lean: async () => bankQuestions }),
      findById: () => ({ lean: async () => null }),
      updateOne: () => Promise.resolve({}),
    },
    loaded: true, id: bankPath,
  };
  require.cache[taxPath] = { exports: { findOne: () => ({ lean: async () => null }) }, loaded: true, id: taxPath };
  require.cache[uoPath] = { exports: { findById: () => ({ lean: async () => null }) }, loaded: true, id: uoPath };
  require.cache[poolPath] = {
    exports: {
      assemblePool: async () => { state.assembleCalled = true; return []; },
      _internal: { calculatePoolAllocation: () => [] },
    },
    loaded: true, id: poolPath,
  };
  delete require.cache[svcPath];
  const svc = require(svcPath);

  const restore = () => {
    for (const p of [daPath, bankPath, taxPath, uoPath, poolPath, svcPath]) {
      if (orig[p]) require.cache[p] = orig[p]; else delete require.cache[p];
    }
  };
  return { svc, state, restore };
}

test('nextQuestion: terminates at exactly the planned total (answers === plan → done)', async () => {
  const q1 = new mongoose.Types.ObjectId(); const q2 = new mongoose.Types.ObjectId();
  const q3 = new mongoose.Types.ObjectId(); const q4 = new mongoose.Types.ObjectId();
  const attempt = {
    _id: new mongoose.Types.ObjectId(),
    totalEstimatedQuestions: 2,               // plan says 2
    poolQuestionIds: [q1, q2, q3, q4],        // pool has 4 (bank over-returned)
    answers: [{ questionId: q1 }, { questionId: q2 }], // 2 answered
    save: async function () { return this; },
  };
  const { svc, restore } = loadWith({ attempt, bankQuestions: [q1, q2, q3, q4].map(qDoc) });
  try {
    const r = await svc.nextQuestion(attempt._id);
    assert.strictEqual(r.done, true, 'must be done once the plan total is answered');
    assert.deepStrictEqual(r.progress, { current: 2, total: 2 }, 'counter caps at the plan, not the pool');
  } finally { restore(); }
});

test('nextQuestion: progress counter reports the PLAN total, never the larger pool size', async () => {
  const q1 = new mongoose.Types.ObjectId(); const q2 = new mongoose.Types.ObjectId();
  const q3 = new mongoose.Types.ObjectId(); const q4 = new mongoose.Types.ObjectId();
  const attempt = {
    _id: new mongoose.Types.ObjectId(),
    totalEstimatedQuestions: 2,
    poolQuestionIds: [q1, q2, q3, q4],
    answers: [{ questionId: q1 }], // 1 answered, plan=2, pool=4
    save: async function () { return this; },
  };
  const { svc, restore } = loadWith({ attempt, bankQuestions: [q1, q2, q3, q4].map(qDoc) });
  try {
    const r = await svc.nextQuestion(attempt._id);
    assert.strictEqual(r.done, false);
    assert.strictEqual(r.progress.total, 2, 'total must be the plan (2), NOT the pool size (4) — the "38 of 24" bug');
    assert.strictEqual(r.progress.current, 2);
  } finally { restore(); }
});

test('nextQuestion: legacy attempt (no totalEstimatedQuestions) falls back to poolQuestionIds.length', async () => {
  const q1 = new mongoose.Types.ObjectId(); const q2 = new mongoose.Types.ObjectId();
  const attempt = {
    _id: new mongoose.Types.ObjectId(),
    totalEstimatedQuestions: undefined,   // legacy doc
    poolQuestionIds: [q1, q2],            // fallback total = 2
    answers: [{ questionId: q1 }, { questionId: q2 }], // 2 answered
    save: async function () { return this; },
  };
  const { svc, restore } = loadWith({ attempt, bankQuestions: [q1, q2].map(qDoc) });
  try {
    const r = await svc.nextQuestion(attempt._id);
    assert.strictEqual(r.done, true);
    assert.deepStrictEqual(r.progress, { current: 2, total: 2 }, 'legacy total derived from poolQuestionIds.length');
  } finally { restore(); }
});

test('nextQuestion: pool is FROZEN — 0 rehydrated docs mid-attempt → done, never re-assembled', async () => {
  const q1 = new mongoose.Types.ObjectId(); const q2 = new mongoose.Types.ObjectId(); const q3 = new mongoose.Types.ObjectId();
  const originalPool = [q1, q2, q3];
  const attempt = {
    _id: new mongoose.Types.ObjectId(),
    totalEstimatedQuestions: 5,
    poolQuestionIds: originalPool,
    answers: [{ questionId: q1 }], // attempt is underway
    objectiveSnapshot: null,
    save: async function () { this._saved = true; return this; },
  };
  // bank returns 0 docs (e.g. bank rows deleted / cache lost mid-attempt)
  const { svc, state, restore } = loadWith({ attempt, bankQuestions: [] });
  try {
    const r = await svc.nextQuestion(attempt._id);
    assert.strictEqual(r.done, true, 'must end gracefully, not serve a fresh batch');
    assert.strictEqual(state.assembleCalled, false, 'assemblePool must NOT run for an attempt with answers (freeze)');
    assert.deepStrictEqual(attempt.poolQuestionIds, originalPool, 'poolQuestionIds must not be overwritten');
    assert.notStrictEqual(attempt._saved, true, 'a frozen attempt must not be re-saved with a new pool');
  } finally { restore(); }
});

test('nextQuestion: fresh attempt (0 answers) still assembles a pool — freeze does not touch onboarding', async () => {
  const attempt = {
    _id: new mongoose.Types.ObjectId(),
    totalEstimatedQuestions: undefined, // neither plan nor pool yet
    poolQuestionIds: [],
    answers: [],                        // brand new
    objectiveSnapshot: null,
    selfRatings: new Map(),
    save: async function () { return this; },
  };
  // Reassembly path returns 0 → nextQuestion reports done with pool-size total (unchanged legacy behaviour).
  const { svc, state, restore } = loadWith({ attempt, bankQuestions: [] });
  try {
    const r = await svc.nextQuestion(attempt._id);
    assert.strictEqual(state.assembleCalled, true, 'a 0-answer attempt still assembles (no freeze)');
    assert.strictEqual(r.done, true, 'empty assembled pool → done, current/total both 0 (behaviour unchanged)');
  } finally { restore(); }
});
