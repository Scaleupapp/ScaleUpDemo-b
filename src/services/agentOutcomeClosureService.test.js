'use strict';
const { test } = require('node:test');
const assert = require('assert');
const mongoose = require('mongoose');
const { closeCompassActionOutcomes } = require('./agentOutcomeClosureService');

function fakeRow({ status = 'accepted', ops, adjustmentDiff = undefined, saveImpl } = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId(),
    status,
    action: { ops },
    adjustmentDiff,
    outcomeSignal: undefined,
    respondedAt: new Date(Date.now() - 48 * 3600 * 1000),
    save: saveImpl || (async function () { this.saved = true; return this; }),
  };
}
function fakeDecisionModel(rows) {
  return { find: () => ({ exec: async () => rows }) };
}
function fakePlanModel(taskStatusById) {
  return {
    findOne: () => ({ lean: async () => taskStatusById && ({
      weeklySchedule: [{ tasks: Object.entries(taskStatusById).map(([id, st]) => ({ _id: id, progress: { status: st } })) }],
    }) }),
  };
}

test('closure: accepted op that held → followedThrough true', async () => {
  const t = String(new mongoose.Types.ObjectId());
  const row = fakeRow({ ops: [{ op: 'set_task_status', taskId: t, status: 'complete' }] });
  const r = await closeCompassActionOutcomes({}, {
    AgentDecision: fakeDecisionModel([row]),
    Plan: fakePlanModel({ [t]: 'complete' }),
  });
  assert.strictEqual(r.closed, 1);
  assert.strictEqual(row.outcomeSignal.followedThrough, true);
  assert.strictEqual(row.outcomeSignal.ops[0].statusNow, 'complete');
  assert.ok(row.saved);
});

test('closure: adjusted row uses adjustmentDiff not action.ops', async () => {
  const t = String(new mongoose.Types.ObjectId());
  const row = fakeRow({
    status: 'adjusted',
    ops: [{ op: 'set_task_status', taskId: t, status: 'skipped' }], // action.ops — should be ignored
    adjustmentDiff: [{ op: 'set_task_status', taskId: t, status: 'complete' }],
  });
  const r = await closeCompassActionOutcomes({}, {
    AgentDecision: fakeDecisionModel([row]),
    Plan: fakePlanModel({ [t]: 'complete' }),
  });
  assert.strictEqual(r.closed, 1);
  assert.strictEqual(row.outcomeSignal.followedThrough, true);
  assert.strictEqual(row.outcomeSignal.ops[0].proposedStatus, 'complete');
  assert.strictEqual(row.outcomeSignal.ops[0].statusNow, 'complete');
});

test('closure: status mismatch → followedThrough false', async () => {
  const t = String(new mongoose.Types.ObjectId());
  const row = fakeRow({ ops: [{ op: 'set_task_status', taskId: t, status: 'complete' }] });
  const r = await closeCompassActionOutcomes({}, {
    AgentDecision: fakeDecisionModel([row]),
    Plan: fakePlanModel({ [t]: 'pending' }),
  });
  assert.strictEqual(r.closed, 1);
  assert.strictEqual(row.outcomeSignal.followedThrough, false);
  assert.strictEqual(row.outcomeSignal.ops[0].statusNow, 'pending');
  assert.ok(row.saved);
});

test('closure: reset_skipped-only row → closed with followedThrough null', async () => {
  const row = fakeRow({ ops: [{ op: 'reset_skipped' }] });
  const r = await closeCompassActionOutcomes({}, {
    AgentDecision: fakeDecisionModel([row]),
    Plan: fakePlanModel({}),
  });
  assert.strictEqual(r.closed, 1);
  assert.strictEqual(row.outcomeSignal.followedThrough, null);
  assert.deepStrictEqual(row.outcomeSignal.ops, []);
  assert.ok(row.saved);
});

test('closure: missing plan → closed false with note', async () => {
  const t = String(new mongoose.Types.ObjectId());
  const row = fakeRow({ ops: [{ op: 'set_task_status', taskId: t, status: 'complete' }] });
  const r = await closeCompassActionOutcomes({}, {
    AgentDecision: fakeDecisionModel([row]),
    Plan: fakePlanModel(null),
  });
  assert.strictEqual(r.closed, 1);
  assert.strictEqual(row.outcomeSignal.followedThrough, false);
  assert.deepStrictEqual(row.outcomeSignal.ops, []);
  assert.strictEqual(row.outcomeSignal.note, 'active plan not found');
  assert.ok(row.saved);
});

test('closure: a row whose save throws does not break the batch', async () => {
  const t1 = String(new mongoose.Types.ObjectId());
  const t2 = String(new mongoose.Types.ObjectId());
  const badRow = fakeRow({
    ops: [{ op: 'set_task_status', taskId: t1, status: 'complete' }],
    saveImpl: async () => { throw new Error('save exploded'); },
  });
  const goodRow = fakeRow({ ops: [{ op: 'set_task_status', taskId: t2, status: 'complete' }] });
  const r = await closeCompassActionOutcomes({}, {
    AgentDecision: fakeDecisionModel([badRow, goodRow]),
    Plan: fakePlanModel({ [t1]: 'complete', [t2]: 'complete' }),
  });
  assert.strictEqual(r.closed, 1);
  assert.ok(goodRow.saved);
  assert.ok(!badRow.saved);
});
