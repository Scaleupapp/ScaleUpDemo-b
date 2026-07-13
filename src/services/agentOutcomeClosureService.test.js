'use strict';
const { test } = require('node:test');
const assert = require('assert');
const mongoose = require('mongoose');
const { closeCompassActionOutcomes, closeInterviewFocusOutcomes } = require('./agentOutcomeClosureService');

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

// --- closeInterviewFocusOutcomes -------------------------------------------

function fakeFocusRow({ userId, createdAt, saveImpl } = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    userId: userId || new mongoose.Types.ObjectId(),
    agentId: 'interview_coach',
    action: { kind: 'session_focus', dimension: 'communication', reason: 'lowest score' },
    outcomeSignal: undefined,
    createdAt: createdAt || new Date(Date.now() - 10 * 24 * 3600 * 1000),
    save: saveImpl || (async function () { this.saved = true; return this; }),
  };
}
function fakeAgentDecisionFindCapture(rows) {
  let capturedQuery = null;
  const model = {
    find: (query) => {
      capturedQuery = query;
      return { exec: async () => rows };
    },
  };
  return { model, getQuery: () => capturedQuery };
}
function fakeInterviewProgramModel(programByUserId) {
  return {
    findOne: ({ userId }) => ({
      lean: async () => programByUserId[String(userId)] || null,
    }),
  };
}
function fakeInterviewSessionModel(sessions) {
  return {
    find: (query) => ({
      exec: async () => sessions.filter((s) => {
        const ids = (query._id && query._id.$in) || [];
        const inSet = ids.some((id) => String(id) === String(s._id));
        const after = !query.updatedAt || s.updatedAt > query.updatedAt.$gt;
        return inSet && s.status === query.status
          && s.evaluation && s.evaluation.gradeStatus === query['evaluation.gradeStatus']
          && after;
      }),
    }),
  };
}

test('interview-focus closure: graded session after row date -> followedThrough true', async () => {
  const userId = new mongoose.Types.ObjectId();
  const sessionId = new mongoose.Types.ObjectId();
  const rowCreatedAt = new Date(Date.now() - 10 * 24 * 3600 * 1000);
  const row = fakeFocusRow({ userId, createdAt: rowCreatedAt });

  const r = await closeInterviewFocusOutcomes({}, {
    AgentDecision: fakeDecisionModel([row]),
    InterviewProgram: fakeInterviewProgramModel({
      [String(userId)]: { sessionIds: [sessionId] },
    }),
    InterviewSession: fakeInterviewSessionModel([
      {
        _id: sessionId,
        status: 'evaluated',
        evaluation: { gradeStatus: 'graded' },
        updatedAt: new Date(rowCreatedAt.getTime() + 24 * 3600 * 1000),
      },
    ]),
  });

  assert.strictEqual(r.closed, 1);
  assert.strictEqual(row.outcomeSignal.kind, 'interview_focus_followthrough');
  assert.strictEqual(row.outcomeSignal.followedThrough, true);
  assert.strictEqual(row.outcomeSignal.sessionsAfter, 1);
  assert.ok(row.saved);
});

test('interview-focus closure: no graded session after row date -> followedThrough false', async () => {
  const userId = new mongoose.Types.ObjectId();
  const sessionId = new mongoose.Types.ObjectId();
  const rowCreatedAt = new Date(Date.now() - 10 * 24 * 3600 * 1000);
  const row = fakeFocusRow({ userId, createdAt: rowCreatedAt });

  const r = await closeInterviewFocusOutcomes({}, {
    AgentDecision: fakeDecisionModel([row]),
    InterviewProgram: fakeInterviewProgramModel({
      [String(userId)]: { sessionIds: [sessionId] },
    }),
    InterviewSession: fakeInterviewSessionModel([
      {
        _id: sessionId,
        status: 'evaluated',
        evaluation: { gradeStatus: 'graded' },
        // graded BEFORE the recommendation, not after
        updatedAt: new Date(rowCreatedAt.getTime() - 24 * 3600 * 1000),
      },
    ]),
  });

  assert.strictEqual(r.closed, 1);
  assert.strictEqual(row.outcomeSignal.followedThrough, false);
  assert.strictEqual(row.outcomeSignal.sessionsAfter, 0);
  assert.ok(row.saved);
});

test('interview-focus closure: no program for user -> closed false with note', async () => {
  const userId = new mongoose.Types.ObjectId();
  const row = fakeFocusRow({ userId });

  const r = await closeInterviewFocusOutcomes({}, {
    AgentDecision: fakeDecisionModel([row]),
    InterviewProgram: fakeInterviewProgramModel({}),
    InterviewSession: fakeInterviewSessionModel([]),
  });

  assert.strictEqual(r.closed, 1);
  assert.strictEqual(row.outcomeSignal.followedThrough, false);
  assert.strictEqual(row.outcomeSignal.sessionsAfter, 0);
  assert.strictEqual(row.outcomeSignal.note, 'no program');
  assert.ok(row.saved);
});

test('interview-focus closure: a row whose save throws does not break the batch', async () => {
  const userId1 = new mongoose.Types.ObjectId();
  const userId2 = new mongoose.Types.ObjectId();
  const badRow = fakeFocusRow({
    userId: userId1,
    saveImpl: async () => { throw new Error('save exploded'); },
  });
  const goodRow = fakeFocusRow({ userId: userId2 });

  const r = await closeInterviewFocusOutcomes({}, {
    AgentDecision: fakeDecisionModel([badRow, goodRow]),
    InterviewProgram: fakeInterviewProgramModel({}),
    InterviewSession: fakeInterviewSessionModel([]),
  });

  assert.strictEqual(r.closed, 1);
  assert.ok(goodRow.saved);
  assert.ok(!badRow.saved);
});

test('interview-focus closure: selection filter shape (agentId, action.kind, outcomeSignal null, createdAt cutoff)', async () => {
  const olderThanDays = 7;
  const { model, getQuery } = fakeAgentDecisionFindCapture([]);
  const before = Date.now();

  await closeInterviewFocusOutcomes({ olderThanDays }, {
    AgentDecision: model,
    InterviewProgram: fakeInterviewProgramModel({}),
    InterviewSession: fakeInterviewSessionModel([]),
  });

  const query = getQuery();
  assert.strictEqual(query.agentId, 'interview_coach');
  assert.strictEqual(query['action.kind'], 'session_focus');
  assert.strictEqual(query.outcomeSignal, null);
  assert.ok(query.createdAt && query.createdAt.$lt instanceof Date);
  const expectedCutoff = before - olderThanDays * 24 * 3600 * 1000;
  // allow small timing slack between `before` and the call inside the function
  assert.ok(Math.abs(query.createdAt.$lt.getTime() - expectedCutoff) < 5000);
});
