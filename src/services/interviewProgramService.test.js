'use strict';

const { test } = require('node:test');
const assert = require('assert');

const {
  createProgram,
  attachSession,
  abandonProgram,
  computeNextFocus,
  getProgram,
  _helpers,
} = require('./interviewProgramService');

// ── Fakes ────────────────────────────────────────────────────────────────

const USER = 'user-1';

/** A Mongoose Query is both awaitable and chainable with .lean() — this
 * tiny thenable reproduces both without pulling in real Mongoose. */
function queryResult(value) {
  const p = Promise.resolve(value);
  return {
    lean: async () => value,
    then: p.then.bind(p),
    catch: p.catch.bind(p),
  };
}

function matchesProgram(doc, filter) {
  if (filter.userId !== undefined && String(doc.userId) !== String(filter.userId)) return false;
  if (filter.status !== undefined && doc.status !== filter.status) return false;
  return true;
}

/** Wraps a mutable array of plain program fixtures as an InterviewProgram-
 * like model: findOne() runs a real filter match, create() pushes a new
 * Document-like object (with .save()) into the store. */
function makeProgramModel(store, { failCreateWithDupKey = false } = {}) {
  return {
    findOne: (filter) => queryResult(store.find((p) => matchesProgram(p, filter)) || null),
    create: async (payload) => {
      if (failCreateWithDupKey) {
        const e = new Error('E11000 duplicate key error collection: one_active_program_per_user');
        e.code = 11000;
        throw e;
      }
      const doc = {
        _id: payload._id || `prog-${store.length + 1}`,
        userId: payload.userId,
        targetRole: payload.targetRole,
        targetCompany: payload.targetCompany,
        driveDate: payload.driveDate,
        status: payload.status || 'active',
        weeks: payload.weeks,
        sessionIds: payload.sessionIds ? [...payload.sessionIds] : [],
        focusHistory: payload.focusHistory ? [...payload.focusHistory] : [],
        createdAt: payload.createdAt || new Date(),
      };
      doc.save = async function () { this._saveCount = (this._saveCount || 0) + 1; };
      store.push(doc);
      return doc;
    },
  };
}

function program(overrides = {}) {
  return {
    _id: 'prog-1',
    userId: USER,
    targetRole: 'SWE',
    targetCompany: 'Acme',
    status: 'active',
    weeks: 4,
    sessionIds: [],
    focusHistory: [],
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    save: async function () { this._saveCount = (this._saveCount || 0) + 1; },
    ...overrides,
  };
}

/** Wraps a plain array of graded-session fixtures as an InterviewSession-
 * like model: find().sort().lean() — the fixtures are supplied pre-sorted
 * oldest-first (the real DB sort is a Mongo feature, not custom logic). */
function makeSessionModel(sessions) {
  return {
    find: (filter) => {
      const ids = new Set(((filter._id && filter._id.$in) || []).map(String));
      const matched = sessions.filter((s) =>
        ids.has(String(s._id)) &&
        s.status === filter.status &&
        s.evaluation && s.evaluation.gradeStatus === filter['evaluation.gradeStatus']);
      return { sort: () => ({ lean: async () => matched }) };
    },
  };
}

function gradedSession(id, scores) {
  return {
    _id: id,
    status: 'evaluated',
    evaluation: {
      gradeStatus: 'graded',
      communication: { score: scores.communication },
      content: { score: scores.content },
      structure: { score: scores.structure },
      confidence: { score: scores.confidence },
    },
  };
}

function baseDeps(overrides = {}) {
  return {
    isAgentEnabled: () => true,
    record: async () => {},
    now: () => new Date('2026-07-12T00:00:00.000Z'),
    ...overrides,
  };
}

// ── createProgram ────────────────────────────────────────────────────────

test('createProgram: flag off -> null, zero writes', async () => {
  const store = [];
  let createCalled = false;
  const deps = baseDeps({
    isAgentEnabled: () => false,
    InterviewProgram: { ...makeProgramModel(store), create: async () => { createCalled = true; } },
    record: async () => { throw new Error('record should not be called'); },
  });
  const result = await createProgram({ userId: USER, targetRole: 'PM' }, deps);
  assert.strictEqual(result, null);
  assert.strictEqual(createCalled, false);
});

test('createProgram: one-active guard — throws when an active program already exists', async () => {
  const store = [program()];
  const deps = baseDeps({ InterviewProgram: makeProgramModel(store) });
  await assert.rejects(
    () => createProgram({ userId: USER, targetRole: 'PM' }, deps),
    /program already active/,
  );
  assert.strictEqual(store.length, 1); // no second row created
});

test('createProgram: race backstop — duplicate-key error (11000) from create() maps to the same message', async () => {
  const store = []; // app-level guard sees nothing active (the race window)
  const deps = baseDeps({ InterviewProgram: makeProgramModel(store, { failCreateWithDupKey: true }) });
  await assert.rejects(
    () => createProgram({ userId: USER, targetRole: 'PM' }, deps),
    /program already active/,
  );
});

test('createProgram: success — creates row, defaults weeks to 4, records program_created ledger row', async () => {
  const store = [];
  const recorded = [];
  const deps = baseDeps({
    InterviewProgram: makeProgramModel(store),
    record: async (payload) => recorded.push(payload),
  });
  const result = await createProgram({ userId: USER, targetRole: 'PM', targetCompany: 'Acme' }, deps);
  assert.strictEqual(result.status, 'active');
  assert.strictEqual(result.weeks, 4);
  assert.strictEqual(recorded.length, 1);
  assert.strictEqual(recorded[0].agentId, 'interview_coach');
  assert.strictEqual(recorded[0].decisionType, 'recommendation');
  assert.strictEqual(recorded[0].userId, USER);
  assert.strictEqual(recorded[0].action.kind, 'program_created');
  assert.strictEqual(recorded[0].promptVersion, 'interview-coach-v1');
});

// ── attachSession ────────────────────────────────────────────────────────

test('attachSession: flag off -> {attached:false}, no mutation', async () => {
  const store = [program()];
  const deps = baseDeps({ isAgentEnabled: () => false, InterviewProgram: makeProgramModel(store) });
  const result = await attachSession({ userId: USER, sessionId: 'sess-1' }, deps);
  assert.deepStrictEqual(result, { attached: false });
  assert.deepStrictEqual(store[0].sessionIds, []);
});

test('attachSession: no active program -> {attached:false} (hook safety, never throws)', async () => {
  const deps = baseDeps({ InterviewProgram: makeProgramModel([]) });
  const result = await attachSession({ userId: USER, sessionId: 'sess-1' }, deps);
  assert.deepStrictEqual(result, { attached: false });
});

test('attachSession: active program -> pushes sessionId, saves, {attached:true}', async () => {
  const store = [program()];
  const deps = baseDeps({ InterviewProgram: makeProgramModel(store) });
  const result = await attachSession({ userId: USER, sessionId: 'sess-1' }, deps);
  assert.deepStrictEqual(result, { attached: true });
  assert.deepStrictEqual(store[0].sessionIds, ['sess-1']);
  assert.strictEqual(store[0]._saveCount, 1);
});

test('attachSession: idempotent — sessionId already attached -> {attached:false}, no duplicate push, no extra save', async () => {
  const store = [program({ sessionIds: ['sess-1'] })];
  const deps = baseDeps({ InterviewProgram: makeProgramModel(store) });
  const result = await attachSession({ userId: USER, sessionId: 'sess-1' }, deps);
  assert.deepStrictEqual(result, { attached: false });
  assert.deepStrictEqual(store[0].sessionIds, ['sess-1']); // still exactly one entry
  assert.strictEqual(store[0]._saveCount, undefined); // save() never called
});

test('attachSession: idempotent dedupe matches across ObjectId vs string sessionId', async () => {
  const store = [program({ sessionIds: [{ toString: () => 'sess-1' }] })];
  const deps = baseDeps({ InterviewProgram: makeProgramModel(store) });
  const result = await attachSession({ userId: USER, sessionId: 'sess-1' }, deps);
  assert.deepStrictEqual(result, { attached: false });
  assert.strictEqual(store[0].sessionIds.length, 1);
});

// ── abandonProgram ───────────────────────────────────────────────────────

test('abandonProgram: flag off -> {abandoned:false}, no mutation', async () => {
  const store = [program()];
  const deps = baseDeps({ isAgentEnabled: () => false, InterviewProgram: makeProgramModel(store) });
  const result = await abandonProgram({ userId: USER }, deps);
  assert.deepStrictEqual(result, { abandoned: false });
  assert.strictEqual(store[0].status, 'active');
});

test('abandonProgram: no active program -> {abandoned:false} (idempotent no-op, never throws)', async () => {
  const deps = baseDeps({ InterviewProgram: makeProgramModel([]) });
  const result = await abandonProgram({ userId: USER }, deps);
  assert.deepStrictEqual(result, { abandoned: false });
});

test('abandonProgram: active program -> sets status abandoned, saves, {abandoned:true}', async () => {
  const store = [program()];
  const deps = baseDeps({ InterviewProgram: makeProgramModel(store) });
  const result = await abandonProgram({ userId: USER }, deps);
  assert.deepStrictEqual(result, { abandoned: true });
  assert.strictEqual(store[0].status, 'abandoned');
  assert.strictEqual(store[0]._saveCount, 1);
});

test('abandonProgram: idempotent — calling twice only mutates once (second call finds no active program)', async () => {
  const store = [program()];
  const deps = baseDeps({ InterviewProgram: makeProgramModel(store) });
  const first = await abandonProgram({ userId: USER }, deps);
  const second = await abandonProgram({ userId: USER }, deps);
  assert.deepStrictEqual(first, { abandoned: true });
  assert.deepStrictEqual(second, { abandoned: false });
  assert.strictEqual(store[0].status, 'abandoned');
});

// ── computeNextFocus — pure math ────────────────────────────────────────

test('computeNextFocus: flag off -> null', async () => {
  const deps = baseDeps({ isAgentEnabled: () => false, InterviewProgram: makeProgramModel([program()]) });
  assert.strictEqual(await computeNextFocus({ userId: USER }, deps), null);
});

test('computeNextFocus: no active program -> null', async () => {
  const deps = baseDeps({ InterviewProgram: makeProgramModel([]) });
  assert.strictEqual(await computeNextFocus({ userId: USER }, deps), null);
});

test('computeNextFocus: baseline case — zero graded sessions -> focus null-dimension, "baseline needed", no ledger write', async () => {
  const store = [program()];
  const recorded = [];
  const deps = baseDeps({
    InterviewProgram: makeProgramModel(store),
    InterviewSession: makeSessionModel([]),
    record: async (payload) => recorded.push(payload),
  });
  const result = await computeNextFocus({ userId: USER }, deps);
  assert.deepStrictEqual(result.focus, { dimension: null, score: null, delta: null, reason: 'baseline needed' });
  assert.strictEqual(result.sessionsCompleted, 0);
  assert.strictEqual(result.trends.length, 4);
  assert.ok(result.trends.every((t) => t.scores.length === 0 && t.delta === null));
  assert.strictEqual(recorded.length, 0);
  assert.strictEqual(store[0].focusHistory.length, 0);
});

test('computeNextFocus: lowest-latest score picks the focus dimension', async () => {
  const store = [program({ sessionIds: ['s1'] })];
  const sessions = [gradedSession('s1', { communication: 80, content: 60, structure: 70, confidence: 90 })];
  const deps = baseDeps({
    InterviewProgram: makeProgramModel(store),
    InterviewSession: makeSessionModel(sessions),
  });
  const result = await computeNextFocus({ userId: USER }, deps);
  assert.strictEqual(result.focus.dimension, 'content');
  assert.strictEqual(result.focus.score, 60);
  assert.strictEqual(result.focus.delta, null); // baseline for that dimension — one data point
  assert.match(result.focus.reason, /lowest-scoring area \(60\/100\)/);
});

test('computeNextFocus: delta is latest minus previous graded score for that dimension', async () => {
  const store = [program({ sessionIds: ['s1', 's2'] })];
  const sessions = [
    gradedSession('s1', { communication: 80, content: 70, structure: 85, confidence: 90 }),
    gradedSession('s2', { communication: 60, content: 75, structure: 88, confidence: 91 }),
  ];
  const deps = baseDeps({
    InterviewProgram: makeProgramModel(store),
    InterviewSession: makeSessionModel(sessions),
  });
  const result = await computeNextFocus({ userId: USER }, deps);
  assert.strictEqual(result.focus.dimension, 'communication');
  assert.strictEqual(result.focus.score, 60);
  assert.strictEqual(result.focus.delta, -20);
  assert.match(result.focus.reason, /dropped 20 pts/);
});

test('computeNextFocus: tie on latest score -> largest negative delta wins the tie-break', async () => {
  const store = [program({ sessionIds: ['s1', 's2'] })];
  const sessions = [
    gradedSession('s1', { communication: 75, content: 90, structure: 80, confidence: 90 }),
    gradedSession('s2', { communication: 60, content: 90, structure: 60, confidence: 90 }),
  ];
  const deps = baseDeps({
    InterviewProgram: makeProgramModel(store),
    InterviewSession: makeSessionModel(sessions),
  });
  const result = await computeNextFocus({ userId: USER }, deps);
  // Both communication (75->60, delta -15) and structure (80->60, delta -20)
  // tie at latest=60; structure's delta is more negative, so it wins.
  assert.strictEqual(result.focus.dimension, 'structure');
  assert.strictEqual(result.focus.delta, -20);
});

test('computeNextFocus: same focus across calls -> no ledger spam, one focusHistory entry', async () => {
  const store = [program({ sessionIds: ['s1'] })];
  const sessions = [gradedSession('s1', { communication: 80, content: 60, structure: 70, confidence: 90 })];
  const recorded = [];
  const deps = baseDeps({
    InterviewProgram: makeProgramModel(store),
    InterviewSession: makeSessionModel(sessions),
    record: async (payload) => recorded.push(payload),
  });
  await computeNextFocus({ userId: USER }, deps);
  await computeNextFocus({ userId: USER }, deps);
  assert.strictEqual(recorded.length, 1);
  assert.strictEqual(store[0].focusHistory.length, 1);
  assert.strictEqual(recorded[0].action.kind, 'session_focus');
  assert.strictEqual(recorded[0].action.dimension, 'content');
});

test('computeNextFocus: focus dimension change appends a new focusHistory entry + records again', async () => {
  const store = [program({ sessionIds: ['s1'] })];
  let sessions = [gradedSession('s1', { communication: 80, content: 60, structure: 70, confidence: 90 })];
  const recorded = [];
  const deps = baseDeps({
    InterviewProgram: makeProgramModel(store),
    InterviewSession: { find: (filter) => ({ sort: () => ({ lean: async () => sessions }) }) },
    record: async (payload) => recorded.push(payload),
  });
  const first = await computeNextFocus({ userId: USER }, deps);
  assert.strictEqual(first.focus.dimension, 'content');

  // A new session shifts the lowest-latest dimension to 'structure'.
  store[0].sessionIds.push('s2');
  sessions = [
    ...sessions,
    gradedSession('s2', { communication: 85, content: 88, structure: 40, confidence: 90 }),
  ];
  const second = await computeNextFocus({ userId: USER }, deps);
  assert.strictEqual(second.focus.dimension, 'structure');

  assert.strictEqual(recorded.length, 2);
  assert.strictEqual(store[0].focusHistory.length, 2);
  assert.strictEqual(store[0].focusHistory[0].dimension, 'content');
  assert.strictEqual(store[0].focusHistory[1].dimension, 'structure');
});

// ── computeWeeksElapsed — pure math boundary ────────────────────────────

test('computeWeeksElapsed: 1-indexed, clamped to [1, totalWeeks]', () => {
  const created = new Date('2026-07-01T00:00:00.000Z');
  assert.strictEqual(_helpers.computeWeeksElapsed(created, new Date('2026-07-01T00:00:00.000Z'), 4), 1);
  assert.strictEqual(_helpers.computeWeeksElapsed(created, new Date('2026-07-08T00:00:00.000Z'), 4), 2); // exactly 7 days -> week 2
  assert.strictEqual(_helpers.computeWeeksElapsed(created, new Date('2026-07-31T00:00:00.000Z'), 4), 4); // overrun clamps to totalWeeks
});

// ── getProgram — client shape ────────────────────────────────────────────

test('getProgram: flag off -> null', async () => {
  const deps = baseDeps({ isAgentEnabled: () => false, InterviewProgram: makeProgramModel([program()]) });
  assert.strictEqual(await getProgram({ userId: USER }, deps), null);
});

test('getProgram: no active program -> null', async () => {
  const deps = baseDeps({ InterviewProgram: makeProgramModel([]) });
  assert.strictEqual(await getProgram({ userId: USER }, deps), null);
});

test('getProgram: baseline shape — target/weekStrip/trends/focus/suggestion, read-only (no writes)', async () => {
  const store = [program()];
  const recorded = [];
  const deps = baseDeps({
    InterviewProgram: makeProgramModel(store),
    InterviewSession: makeSessionModel([]),
    record: async (payload) => recorded.push(payload),
  });
  const result = await getProgram({ userId: USER }, deps);
  assert.deepStrictEqual(result.target, { role: 'SWE', company: 'Acme', driveDate: null });
  assert.deepStrictEqual(result.weekStrip, { current: 2, total: 4 }); // created 7/1, now 7/12 -> 11 days -> week 2
  assert.strictEqual(result.focus.dimension, null);
  assert.strictEqual(result.suggestion, 'Complete your first graded mock interview to unlock a personalized focus area.');
  assert.strictEqual(recorded.length, 0);
  assert.strictEqual(store[0].focusHistory.length, 0);
});

test('getProgram: with a graded session, suggestion copy names the focus dimension', async () => {
  const store = [program({ sessionIds: ['s1'] })];
  const sessions = [gradedSession('s1', { communication: 80, content: 60, structure: 70, confidence: 90 })];
  const deps = baseDeps({
    InterviewProgram: makeProgramModel(store),
    InterviewSession: makeSessionModel(sessions),
  });
  const result = await getProgram({ userId: USER }, deps);
  assert.strictEqual(result.focus.dimension, 'content');
  assert.match(result.suggestion, /^Your next session should focus on Content:/);
});
