const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

const planModelPath = require.resolve('../models/Plan');
const attemptModelPath = require.resolve('../models/DiagnosticAttempt');

let activePlan = null;
let latestAttempt = null;
require.cache[planModelPath] = {
  exports: {
    findOne: (filter) => ({ sort: () => ({ lean: async () => activePlan }) }),
  },
};
require.cache[attemptModelPath] = {
  exports: {
    findOne: (filter) => ({ sort: () => ({ select: () => ({ lean: async () => latestAttempt }) }) }),
  },
};

delete require.cache[require.resolve('./planController')];
const ctrl = require('./planController');

function fakeRes() {
  const r = { _status: 200, _json: null };
  r.status = (s) => { r._status = s; return r; };
  r.json = (j) => { r._json = j; return r; };
  return r;
}

test('planController.getStatus: returns generating when no plan yet', async () => {
  activePlan = null;
  latestAttempt = { planGenerationStatus: 'generating' };
  const req = { user: { userId: new mongoose.Types.ObjectId() } };
  const res = fakeRes();
  await ctrl.getStatus(req, res);
  assert.strictEqual(res._json.status, 'generating');
});

test('planController.getStatus: returns ready when plan exists', async () => {
  activePlan = { _id: new mongoose.Types.ObjectId(), source: 'llm-generated', updatedAt: new Date() };
  latestAttempt = { planGenerationStatus: 'ready', planId: activePlan._id };
  const req = { user: { userId: new mongoose.Types.ObjectId() } };
  const res = fakeRes();
  await ctrl.getStatus(req, res);
  assert.strictEqual(res._json.status, 'ready');
  assert.ok(res._json.planId);
});

test('planController.getCurrent: returns the active plan', async () => {
  activePlan = {
    _id: new mongoose.Types.ObjectId(),
    planHeadline: 'h',
    estimatedTotalHours: 10,
    weeklySchedule: [],
    milestones: [],
    source: 'template',
  };
  const req = { user: { userId: new mongoose.Types.ObjectId() } };
  const res = fakeRes();
  await ctrl.getCurrent(req, res);
  assert.strictEqual(res._json.planHeadline, 'h');
  assert.strictEqual(res._json.source, 'template');
});

test('planController.getCurrent: returns 404 when no plan', async () => {
  activePlan = null;
  const req = { user: { userId: new mongoose.Types.ObjectId() } };
  const res = fakeRes();
  await ctrl.getCurrent(req, res);
  assert.strictEqual(res._status, 404);
});
