'use strict';

const { test } = require('node:test');
const assert = require('assert');

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

function buildStubs({ questions = [], validateResult = null } = {}) {
  const qbPath        = require.resolve('../models/DiagnosticQuestionBank');
  const validatorPath = require.resolve('../services/diagnostic/questionValidatorService');
  const workerPath    = require.resolve('./validatorBackfillWorker');

  const updatedIds = [];

  require.cache[qbPath] = {
    id: qbPath, filename: qbPath, loaded: true,
    exports: {
      find: () => ({
        limit: () => ({
          lean: async () => questions,
        }),
      }),
      findByIdAndUpdate: async (id, update) => {
        updatedIds.push({ id: String(id), status: update.verificationStatus });
      },
    },
  };

  require.cache[validatorPath] = {
    id: validatorPath, filename: validatorPath, loaded: true,
    exports: {
      validateQuestion: async () =>
        validateResult || { score: 95, critique: 'Excellent', issues: [], status: 'auto_verified' },
    },
  };

  delete require.cache[workerPath];
  const worker = require('./validatorBackfillWorker');
  return { worker, getUpdates: () => updatedIds };
}

function teardown() {
  [
    '../models/DiagnosticQuestionBank',
    '../services/diagnostic/questionValidatorService',
    './validatorBackfillWorker',
  ].forEach(p => {
    try { delete require.cache[require.resolve(p)]; } catch {}
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('validatorBackfillWorker: returns zero counts when no pending questions', async () => {
  const { worker } = buildStubs({ questions: [] });
  try {
    const result = await worker.runBackfill();
    assert.strictEqual(result.processed, 0);
    assert.strictEqual(result.promoted, 0);
    assert.strictEqual(result.demoted, 0);
    assert.strictEqual(result.unchanged, 0);
  } finally {
    teardown();
  }
});

test('validatorBackfillWorker: promotes question when validator returns auto_verified', async () => {
  const questions = [{ _id: 'q1', verificationStatus: 'pending' }];
  const { worker, getUpdates } = buildStubs({
    questions,
    validateResult: { score: 92, critique: 'Good', issues: [], status: 'auto_verified' },
  });
  try {
    const result = await worker.runBackfill();
    assert.strictEqual(result.processed, 1);
    assert.strictEqual(result.promoted, 1);
    assert.strictEqual(result.demoted, 0);
    assert.strictEqual(getUpdates()[0].status, 'auto_verified');
  } finally {
    teardown();
  }
});

test('validatorBackfillWorker: demotes question when validator returns flagged_for_review', async () => {
  const questions = [{ _id: 'q2', verificationStatus: 'pending' }];
  const { worker, getUpdates } = buildStubs({
    questions,
    validateResult: { score: 55, critique: 'Bad', issues: ['ambiguous'], status: 'flagged_for_review' },
  });
  try {
    const result = await worker.runBackfill();
    assert.strictEqual(result.processed, 1);
    assert.strictEqual(result.promoted, 0);
    assert.strictEqual(result.demoted, 1);
    assert.strictEqual(getUpdates()[0].status, 'flagged_for_review');
  } finally {
    teardown();
  }
});

test('validatorBackfillWorker: counts unchanged when validator still returns pending', async () => {
  const questions = [{ _id: 'q3', verificationStatus: 'pending' }];
  const { worker, getUpdates } = buildStubs({
    questions,
    validateResult: { score: 75, critique: 'Usable', issues: [], status: 'pending' },
  });
  try {
    const result = await worker.runBackfill();
    assert.strictEqual(result.processed, 1);
    assert.strictEqual(result.unchanged, 1);
    assert.strictEqual(getUpdates().length, 0, 'should not write when status unchanged');
  } finally {
    teardown();
  }
});

test('validatorBackfillWorker: dryRun skips database writes', async () => {
  const questions = [{ _id: 'q4', verificationStatus: 'pending' }];
  const { worker, getUpdates } = buildStubs({
    questions,
    validateResult: { score: 95, critique: 'Great', issues: [], status: 'auto_verified' },
  });
  try {
    const result = await worker.runBackfill({ dryRun: true });
    assert.strictEqual(result.promoted, 1);
    assert.strictEqual(getUpdates().length, 0, 'dryRun must not write to DB');
  } finally {
    teardown();
  }
});
