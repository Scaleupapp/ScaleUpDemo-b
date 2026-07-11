'use strict';

/**
 * Block 6 (Wave 2) — stranding fixes + admin recovery.
 *
 * Covers:
 *  - markDrillAttemptFailed (worker final-retry path)
 *  - drills controller getResult surfaces 'failed' (200, not eternal 202)
 *  - calibration result surfaces terminal 'failed'
 *  - capstoneEval revertEvaluatingToSubmitted
 *  - admin assessmentRecoveryService: findStuck + regradeSession per engine
 *
 * All models/queues stubbed — no DB / Redis.
 */

require('dotenv').config();
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

// ── DrillAttempt model statics stubbed in place (singleton mongoose model) ───

const models = require('../../coding/models');
const { DrillAttempt } = models;

let attemptDoc = null; // controlled per test
let capturedDrillUpdate = null;

DrillAttempt.findOneAndUpdate = async (filter, update) => {
  capturedDrillUpdate = { filter, update };
  return { _id: filter._id, ...update.$set };
};
DrillAttempt.findOne = () => ({ sort: () => ({ lean: async () => attemptDoc }) });
DrillAttempt.find = async () => [];

// ── markDrillAttemptFailed ───────────────────────────────────────────────────

const { markDrillAttemptFailed } = require('../../coding/workers/drillGrader.worker');

test('markDrillAttemptFailed: flips submitted → failed with reason (conditional)', async () => {
  capturedDrillUpdate = null;
  const id = new mongoose.Types.ObjectId();
  await markDrillAttemptFailed(id, 'LLM returned garbage');
  assert.equal(String(capturedDrillUpdate.filter._id), String(id));
  assert.equal(capturedDrillUpdate.filter.status, 'submitted', 'must be conditional on submitted');
  assert.equal(capturedDrillUpdate.update.$set.status, 'failed');
  assert.equal(capturedDrillUpdate.update.$set.failure_reason, 'LLM returned garbage');
});

// ── drills controller: failed surface ────────────────────────────────────────

const controller = require('../../coding/controllers/drills.controller');

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

test('getResult: failed attempt → 200 {status:failed} (poll terminates)', async () => {
  attemptDoc = {
    _id: 'att1',
    status: 'failed',
    failure_reason: 'grading exploded',
  };
  const res = fakeRes();
  await controller.getResult({ user: { userId: 'u1' }, params: { id: 'b1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'failed');
  assert.equal(res.body.error, 'grading_failed');
  assert.equal(res.body.detail, 'grading exploded');
});

test('getResult: submitted attempt still → 202 (in flight)', async () => {
  attemptDoc = { _id: 'att1', status: 'submitted' };
  const res = fakeRes();
  await controller.getResult({ user: { userId: 'u1' }, params: { id: 'b1' } }, res);
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.status, 'submitted');
});

test('getCalibrationResult: all terminal with one failed → 200 status failed', async () => {
  const origFind = DrillAttempt.find;
  DrillAttempt.find = async () => ([
    { _id: 'a1', drill_subtype: 'prompt', status: 'graded', grade: { overall_score: 70, rubric_breakdown: [], what_you_missed: [] }, calibration_committed: true },
    { _id: 'a2', drill_subtype: 'verify', status: 'graded', grade: { overall_score: 60, rubric_breakdown: [], what_you_missed: [] }, calibration_committed: true },
    { _id: 'a3', drill_subtype: 'decompose', status: 'failed', grade: null, calibration_committed: true },
  ]);
  try {
    const res = fakeRes();
    await controller.getCalibrationResult({ user: { userId: 'u1' }, params: { calibration_id: 'cal1' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'failed');
    assert.equal(res.body.error, 'grading_failed');
    assert.equal(res.body.drills.length, 3);
  } finally {
    DrillAttempt.find = origFind;
  }
});

test('getCalibrationResult: one failed but one still in flight → 202 partial', async () => {
  const origFind = DrillAttempt.find;
  DrillAttempt.find = async () => ([
    { _id: 'a1', drill_subtype: 'prompt', status: 'graded', grade: { overall_score: 70, rubric_breakdown: [], what_you_missed: [] } },
    { _id: 'a2', drill_subtype: 'verify', status: 'submitted', grade: null },
    { _id: 'a3', drill_subtype: 'decompose', status: 'failed', grade: null },
  ]);
  try {
    const res = fakeRes();
    await controller.getCalibrationResult({ user: { userId: 'u1' }, params: { calibration_id: 'cal1' } }, res);
    assert.equal(res.statusCode, 202);
    assert.equal(res.body.status, 'partial');
  } finally {
    DrillAttempt.find = origFind;
  }
});

// ── capstone revert ──────────────────────────────────────────────────────────

test('revertEvaluatingToSubmitted: conditional evaluating → submitted', async () => {
  const CapstoneSession = require('../../coding/models/capstoneSession.model');
  let captured = null;
  const orig = CapstoneSession.findOneAndUpdate;
  CapstoneSession.findOneAndUpdate = async (filter, update) => { captured = { filter, update }; return { _id: filter._id }; };
  try {
    const { revertEvaluatingToSubmitted } = require('../../coding/workers/capstoneEval.worker');
    await revertEvaluatingToSubmitted('cs1');
    assert.equal(captured.filter.status, 'evaluating');
    assert.equal(captured.update.$set.status, 'submitted');
  } finally {
    CapstoneSession.findOneAndUpdate = orig;
  }
});

// ── admin recovery service ───────────────────────────────────────────────────

const recovery = require('../../services/admin/assessmentRecoveryService');

function listStub(rows) {
  const chain = {
    select: () => chain,
    sort: () => chain,
    limit: () => chain,
    lean: async () => rows,
  };
  return chain;
}

test('findStuck: aggregates capstone/drill/interview strandings', async () => {
  const out = await recovery.findStuck({ thresholdMinutes: 10 }, {
    CapstoneSession: { find: () => listStub([{ _id: 'c1', status: 'evaluating' }]) },
    DrillAttempt: {
      find: (q) => listStub(q.status === 'failed'
        ? [{ _id: 'd2', status: 'failed', failure_reason: 'x' }]
        : [{ _id: 'd1', status: 'submitted' }]),
    },
    InterviewSession: { find: () => listStub([{ _id: 'i1', status: 'completed' }]) },
  });
  assert.equal(out.thresholdMinutes, 10);
  assert.deepEqual(out.capstone.map((c) => c._id), ['c1']);
  assert.deepEqual(out.drill.map((x) => x._id), ['d2', 'd1'], 'failed first, then stuck submits');
  assert.deepEqual(out.interview.map((i) => i._id), ['i1']);
});

test('regradeSession: capstone — reverts evaluating and re-enqueues', async () => {
  const calls = { reverted: false, enqueued: null };
  const out = await recovery.regradeSession('as1', {
    AssessmentSession: { findById: async () => ({ engine: { type: 'capstone', sessionId: 'cs1' } }) },
    CapstoneSession: {
      findById: async () => ({ _id: 'cs1', status: 'evaluating' }),
      findOneAndUpdate: async (f, u) => { calls.reverted = f.status === 'evaluating' && u.$set.status === 'submitted'; return {}; },
    },
    capstoneEval: { enqueueEvaluation: async (id) => { calls.enqueued = id; } },
  });
  assert.equal(out.engine, 'capstone');
  assert.equal(calls.reverted, true);
  assert.equal(calls.enqueued, 'cs1');
});

test('regradeSession: drill — failed attempt reset to submitted + requeued with subtype', async () => {
  const calls = { reset: false, job: null };
  const out = await recovery.regradeSession('as2', {
    AssessmentSession: { findById: async () => ({ engine: { type: 'drill', sessionId: 'da1' } }) },
    DrillAttempt: {
      findById: async () => ({ _id: 'da1', status: 'failed', drill_subtype: 'prompt' }),
      findOneAndUpdate: async (f, u) => { calls.reset = f.status === 'failed' && u.$set.status === 'submitted'; return {}; },
    },
    codingWorkers: { drillGraderQueue: { add: async (name, data) => { calls.job = { name, data }; } } },
  });
  assert.equal(out.engine, 'drill');
  assert.equal(calls.reset, true);
  assert.deepEqual(calls.job.data, { drillAttemptId: 'da1', drill_subtype: 'prompt' });
});

test('regradeSession: interview — evaluating reverted to completed + requeued', async () => {
  const calls = { saved: false, job: null };
  const iv = {
    _id: 'iv1', status: 'evaluating',
    async save() { calls.saved = true; this.savedStatus = this.status; },
  };
  const out = await recovery.regradeSession('as3', {
    AssessmentSession: { findById: async () => ({ engine: { type: 'interview', sessionId: 'iv1' } }) },
    InterviewSession: { findById: async () => iv },
    queues: { interviewEvaluationQueue: { add: async (name, data) => { calls.job = { name, data }; } } },
  });
  assert.equal(out.engine, 'interview');
  assert.equal(iv.status, 'completed');
  assert.equal(calls.saved, true);
  assert.deepEqual(calls.job.data, { sessionId: 'iv1' });
});

test('regradeSession: mcq → UNSUPPORTED_ENGINE', async () => {
  await assert.rejects(
    () => recovery.regradeSession('as4', {
      AssessmentSession: { findById: async () => ({ engine: { type: 'mcq', sessionId: 'q1' } }) },
    }),
    /UNSUPPORTED_ENGINE/
  );
});

test('regradeSession: unknown session → NOT_FOUND', async () => {
  await assert.rejects(
    () => recovery.regradeSession('nope', { AssessmentSession: { findById: async () => null } }),
    /NOT_FOUND/
  );
});
