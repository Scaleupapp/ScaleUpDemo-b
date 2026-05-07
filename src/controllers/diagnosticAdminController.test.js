'use strict';

const { test } = require('node:test');
const assert = require('assert');
const mongoose = require('mongoose');

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

function makeQuestion(overrides = {}) {
  return {
    _id:               new mongoose.Types.ObjectId(),
    questionText:      'What is X?',
    options:           [{ label: 'A', text: 'opt a' }],
    correctAnswer:     'A',
    difficulty:        'medium',
    canonicalCompetency: 'product-strategy',
    verificationStatus: 'flagged_for_review',
    validatorScore:    60,
    validatorCritique: 'Needs improvement',
    humanReviewedBy:   null,
    humanReviewedAt:   null,
    humanReviewNotes:  '',
    save: async function () { return this; },
    ...overrides,
  };
}

function buildStubs({ question = null, decisionCount = 0 } = {}) {
  const qbPath  = require.resolve('../models/DiagnosticQuestionBank');
  const adPath  = require.resolve('../models/AdminQuestionDecision');
  const ctrlPath = require.resolve('./diagnosticAdminController');

  const decisions = [];

  require.cache[qbPath] = {
    id: qbPath, filename: qbPath, loaded: true,
    exports: {
      findById: async (_id) => question,
      find:     (filter) => ({
        sort:  function () { return this; },
        skip:  function () { return this; },
        limit: function () { return this; },
        lean:  async () => question ? [question] : [],
        select: function () { return this; },
      }),
      countDocuments: async () => (question ? 1 : 0),
      deleteOne: async () => ({}),
      aggregate: async () => [{ _id: 'flagged_for_review', count: 3 }],
    },
  };

  require.cache[adPath] = {
    id: adPath, filename: adPath, loaded: true,
    exports: {
      create: async (data) => {
        const d = { _id: new mongoose.Types.ObjectId(), ...data };
        decisions.push(d);
        return d;
      },
      find: () => ({
        sort:  function () { return this; },
        limit: function () { return this; },
        lean:  async () => [],
      }),
      countDocuments: async () => decisionCount,
    },
  };

  // Ensure training signal service doesn't blow up if it doesn't exist yet.
  // Use a deterministic path rather than require.resolve() since the file may not
  // exist at this point in the build sequence.
  const path = require('path');
  const tsPath = path.resolve(__dirname, '../services/diagnostic/adminTrainingSignalService.js');
  require.cache[tsPath] = {
    id: tsPath, filename: tsPath, loaded: true,
    exports: { recordDecision: async () => ({ exported: false, total: 1 }) },
  };

  delete require.cache[ctrlPath];
  const ctrl = require('./diagnosticAdminController');
  return { ctrl, getDecisions: () => decisions };
}

function teardown() {
  const path = require('path');
  [
    '../models/DiagnosticQuestionBank',
    '../models/AdminQuestionDecision',
    './diagnosticAdminController',
  ].forEach(p => {
    try { delete require.cache[require.resolve(p)]; } catch {}
  });
  // Clean up training signal stub (file may not exist so use path directly)
  const tsPath = path.resolve(__dirname, '../services/diagnostic/adminTrainingSignalService.js');
  delete require.cache[tsPath];
}

function mockRes() {
  const res = {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
  };
  return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('getQueue returns paginated flagged_for_review questions', async () => {
  const q = makeQuestion();
  const { ctrl } = buildStubs({ question: q });
  try {
    const req = { query: { page: '1', limit: '20' } };
    const res = mockRes();
    await ctrl.getQueue(req, res);
    assert.strictEqual(res._body.success, true);
    assert.ok(Array.isArray(res._body.data.questions));
    assert.ok(typeof res._body.data.total === 'number');
  } finally {
    teardown();
  }
});

test('approve sets verificationStatus to human_verified and logs decision', async () => {
  const q = makeQuestion();
  const { ctrl, getDecisions } = buildStubs({ question: q });
  try {
    const req = { params: { id: String(q._id) }, user: { userId: 'admin1' }, body: { reason: 'Looks good' } };
    const res = mockRes();
    await ctrl.approve(req, res);
    assert.strictEqual(res._body.success, true);
    assert.strictEqual(q.verificationStatus, 'human_verified');
    const decisions = getDecisions();
    assert.strictEqual(decisions.length, 1);
    assert.strictEqual(decisions[0].action, 'approve');
  } finally {
    teardown();
  }
});

test('edit applies field updates and logs decision with editDiff', async () => {
  const q = makeQuestion({ questionText: 'Old text' });
  const { ctrl, getDecisions } = buildStubs({ question: q });
  try {
    const req = {
      params: { id: String(q._id) },
      user:   { userId: 'admin1' },
      body:   { questionText: 'Updated text', reason: 'Fixed clarity' },
    };
    const res = mockRes();
    await ctrl.edit(req, res);
    assert.strictEqual(res._body.success, true);
    assert.strictEqual(q.questionText, 'Updated text');
    const decisions = getDecisions();
    assert.strictEqual(decisions.length, 1);
    assert.strictEqual(decisions[0].action, 'edit');
    assert.ok(decisions[0].editDiff.questionText, 'editDiff should contain questionText');
    assert.strictEqual(decisions[0].editDiff.questionText.before, 'Old text');
    assert.strictEqual(decisions[0].editDiff.questionText.after, 'Updated text');
  } finally {
    teardown();
  }
});

test('reject deletes question and logs decision', async () => {
  const q = makeQuestion();
  const { ctrl, getDecisions } = buildStubs({ question: q });
  let deleteCalled = false;
  require.cache[require.resolve('../models/DiagnosticQuestionBank')].exports.deleteOne = async () => {
    deleteCalled = true;
    return {};
  };
  try {
    const req = { params: { id: String(q._id) }, user: { userId: 'admin1' }, body: { reason: 'Bad question', regenerate: false } };
    const res = mockRes();
    await ctrl.reject(req, res);
    assert.strictEqual(res._body.success, true);
    assert.strictEqual(deleteCalled, true);
    const decisions = getDecisions();
    assert.strictEqual(decisions.length, 1);
    assert.strictEqual(decisions[0].action, 'reject');
  } finally {
    teardown();
  }
});

test('getStats returns queueDepth, distribution, validatorPassRate', async () => {
  const q = makeQuestion({ validatorScore: 80 });
  const { ctrl } = buildStubs({ question: q });
  try {
    // Override find to return questions with validatorScore
    require.cache[require.resolve('../models/DiagnosticQuestionBank')].exports.find = (filter) => ({
      sort: function () { return this; },
      skip: function () { return this; },
      limit: function () { return this; },
      lean: async () => [{ validatorScore: 80 }, { validatorScore: 50 }],
      select: function () { return this; },
    });

    const req = { query: {} };
    const res = mockRes();
    await ctrl.getStats(req, res);
    assert.strictEqual(res._body.success, true);
    assert.ok('queueDepth' in res._body.data);
    assert.ok('distribution' in res._body.data);
    assert.ok('validatorPassRate' in res._body.data);
  } finally {
    teardown();
  }
});
