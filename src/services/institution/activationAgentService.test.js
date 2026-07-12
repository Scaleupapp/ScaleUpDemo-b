'use strict';

const { test } = require('node:test');
const assert = require('assert');

const { runDaily, getFunnel } = require('./activationAgentService');

// ── Fakes ────────────────────────────────────────────────────────────────

const INST = 'inst1';
const COHORT = 'cohort1';
const NOW = new Date('2026-07-12T00:00:00.000Z');

function daysAgo(n, from = NOW) {
  return new Date(from.getTime() - n * 24 * 60 * 60 * 1000);
}

// Tiny in-memory Mongo-filter matcher — supports exactly the operators the
// service emits ($lt, $lte, $gte, $or, plain equality incl. null-matches-
// missing). Lets us exercise the SERVICE's real query filter end-to-end
// (candidates are chosen by the filter, not by a test pre-filtering fixtures)
// rather than merely asserting on the filter's shape.
function matchesFilter(doc, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') return cond.some((sub) => matchesFilter(doc, sub));
    const actual = doc[key];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      return Object.entries(cond).every(([op, val]) => {
        if (op === '$lt') return actual != null && actual < val;
        if (op === '$lte') return actual != null && actual <= val;
        if (op === '$gte') return actual != null && actual >= val;
        if (op === '$gt') return actual != null && actual > val;
        throw new Error(`unsupported op in test matcher: ${op}`);
      });
    }
    if (cond === null) return actual === null || actual === undefined;
    return String(actual) === String(cond);
  });
}

// Wraps a mutable array of plain student fixtures as a PendingStudent-like
// model: find()/countDocuments() run the real filter against it, and each
// fixture gets a `.save()` that just marks itself saved (mutations already
// happened in place, matching a real Mongoose document).
function makePendingStudentModel(students) {
  for (const s of students) {
    if (!s.save) s.save = async function () { this._saved = (this._saved || 0) + 1; };
  }
  return {
    find: async (filter = {}) => students.filter((s) => matchesFilter(s, filter)),
    countDocuments: async (filter = {}) => students.filter((s) => matchesFilter(s, filter)).length,
  };
}

function student(overrides = {}) {
  return {
    institutionId: INST,
    cohortId: COHORT,
    status: 'invited',
    remindersSent: 0,
    lastReminderAt: null,
    createdAt: daysAgo(30),
    email: `${overrides.name || 's'}@x.edu`,
    ...overrides,
  };
}

function baseDeps(overrides = {}) {
  return {
    Institution: { findById: async () => ({ name: 'NGIT' }) },
    sendInvites: async () => ({ invited: 1, failures: [] }),
    isAgentEnabled: () => true,
    now: () => NOW,
    ...overrides,
  };
}

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

const ENV = { ACTIVATION_MAX_REMINDERS: '3', ACTIVATION_REMINDER_GAP_DAYS: '3' };

// ── runDaily ─────────────────────────────────────────────────────────────

test('runDaily: flag off -> no-op, zero DB reads', () => withEnv(ENV, async () => {
  let listCalled = false;
  const deps = baseDeps({
    isAgentEnabled: () => false,
    listCandidateCohorts: async () => { listCalled = true; return []; },
    PendingStudent: makePendingStudentModel([]),
    record: async () => { throw new Error('record should not be called'); },
  });
  const result = await runDaily(deps);
  assert.deepStrictEqual(result, { cohorts: 0, reminded: 0 });
  assert.strictEqual(listCalled, false);
}));

test('runDaily: boundary — eligibility timestamp EXACTLY GAP (3) days old IS reminded (inclusive <=)', () => withEnv(ENV, async () => {
  const s = student({ name: 'exact', createdAt: daysAgo(3) });
  const recorded = [];
  const deps = baseDeps({
    PendingStudent: makePendingStudentModel([s]),
    listCandidateCohorts: async () => [{ institutionId: INST, cohortId: COHORT }],
    record: async (payload) => { recorded.push(payload); },
  });
  const result = await runDaily(deps);
  assert.strictEqual(result.reminded, 1);
  assert.strictEqual(s.remindersSent, 1);
  assert.deepStrictEqual(s.lastReminderAt, NOW);
  assert.strictEqual(recorded.length, 1);
}));

test('runDaily: boundary — eligibility timestamp GAP-1 (2) days old is NOT reminded yet', () => withEnv(ENV, async () => {
  const s = student({ name: 'tooSoon', createdAt: daysAgo(2) });
  const deps = baseDeps({
    PendingStudent: makePendingStudentModel([s]),
    listCandidateCohorts: async () => [{ institutionId: INST, cohortId: COHORT }],
    record: async () => { throw new Error('record should not be called — nothing reminded'); },
  });
  const result = await runDaily(deps);
  assert.strictEqual(result.reminded, 0);
  assert.strictEqual(s.remindersSent, 0);
}));

test('runDaily: boundary — remindersSent AT MAX (3) is excluded (exhausted, never re-sent)', () => withEnv(ENV, async () => {
  const s = student({ name: 'capped', createdAt: daysAgo(30), remindersSent: 3 });
  let sendCalled = false;
  const deps = baseDeps({
    PendingStudent: makePendingStudentModel([s]),
    listCandidateCohorts: async () => [{ institutionId: INST, cohortId: COHORT }],
    sendInvites: async () => { sendCalled = true; return { invited: 1, failures: [] }; },
    record: async (payload) => {
      // Even though nothing was reminded, exhausted should reflect the capped student.
      assert.strictEqual(payload.action.stats.exhausted, 1);
      throw new Error('record should not be called — reminded is 0');
    },
  });
  const result = await runDaily(deps);
  assert.strictEqual(result.reminded, 0);
  assert.strictEqual(sendCalled, false);
  assert.strictEqual(s.remindersSent, 3);
}));

test('runDaily: a student at MAX-1 becomes exhausted after this run\'s reminder', () => withEnv(ENV, async () => {
  const s = student({ name: 'lastChance', createdAt: daysAgo(30), remindersSent: 2 });
  const recorded = [];
  const deps = baseDeps({
    PendingStudent: makePendingStudentModel([s]),
    listCandidateCohorts: async () => [{ institutionId: INST, cohortId: COHORT }],
    record: async (payload) => recorded.push(payload),
  });
  const result = await runDaily(deps);
  assert.strictEqual(result.reminded, 1);
  assert.strictEqual(s.remindersSent, 3);
  assert.strictEqual(recorded[0].action.stats.exhausted, 1);
}));

test('runDaily: counters persisted via save() — remindersSent incremented and lastReminderAt set', () => withEnv(ENV, async () => {
  const s = student({ name: 'due', createdAt: daysAgo(10) });
  const deps = baseDeps({
    PendingStudent: makePendingStudentModel([s]),
    listCandidateCohorts: async () => [{ institutionId: INST, cohortId: COHORT }],
    record: async () => {},
  });
  await runDaily(deps);
  assert.strictEqual(s.remindersSent, 1);
  assert.deepStrictEqual(s.lastReminderAt, NOW);
  assert.strictEqual(s._saved, 1);
}));

test('runDaily: invalid send isolation — one bad send does not stop the batch, is counted', () => withEnv(ENV, async () => {
  const bad = student({ name: 'bad', createdAt: daysAgo(30) });
  const good = student({ name: 'good', createdAt: daysAgo(30) });
  const recorded = [];
  const deps = baseDeps({
    PendingStudent: makePendingStudentModel([bad, good]),
    listCandidateCohorts: async () => [{ institutionId: INST, cohortId: COHORT }],
    sendInvites: async ([candidate]) => {
      if (candidate.email === 'bad@x.edu') return { invited: 0, failures: [{ to: 'bad@x.edu', error: 'smtp' }] };
      return { invited: 1, failures: [] };
    },
    record: async (payload) => recorded.push(payload),
  });
  const result = await runDaily(deps);
  assert.strictEqual(result.reminded, 1);
  assert.strictEqual(bad.remindersSent, 0);
  assert.strictEqual(good.remindersSent, 1);
  assert.strictEqual(recorded[0].action.stats.invalid, 1);
  assert.strictEqual(recorded[0].action.stats.reminded, 1);
}));

test('runDaily: a thrown sendInvites is also isolated and counted invalid', () => withEnv(ENV, async () => {
  const s = student({ name: 'throws', createdAt: daysAgo(30) });
  const deps = baseDeps({
    PendingStudent: makePendingStudentModel([s]),
    listCandidateCohorts: async () => [{ institutionId: INST, cohortId: COHORT }],
    sendInvites: async () => { throw new Error('network down'); },
    record: async () => { throw new Error('record should not be called — reminded is 0'); },
  });
  const result = await runDaily(deps);
  assert.strictEqual(result.reminded, 0);
  assert.strictEqual(s.remindersSent, 0);
}));

test('runDaily: one batch ledger row only when reminded >= 1 — zero-eligible cohort writes nothing', () => withEnv(ENV, async () => {
  // Only claimed/expired students in this cohort — nothing 'invited' at all.
  const claimedOnly = student({ name: 'claimed', status: 'claimed' });
  const deps = baseDeps({
    PendingStudent: makePendingStudentModel([claimedOnly]),
    listCandidateCohorts: async () => [{ institutionId: INST, cohortId: COHORT }],
    record: async () => { throw new Error('record should not be called'); },
  });
  const result = await runDaily(deps);
  assert.strictEqual(result.cohorts, 0);
  assert.strictEqual(result.reminded, 0);
}));

test('runDaily: batch row shape — agentId/decisionType/action.kind/promptVersion + caps echoed', () => withEnv(ENV, async () => {
  const s = student({ name: 'due', createdAt: daysAgo(30) });
  const recorded = [];
  const deps = baseDeps({
    PendingStudent: makePendingStudentModel([s]),
    listCandidateCohorts: async () => [{ institutionId: INST, cohortId: COHORT }],
    record: async (payload) => recorded.push(payload),
  });
  const result = await runDaily(deps);
  assert.strictEqual(result.cohorts, 1);
  assert.strictEqual(recorded.length, 1);
  const row = recorded[0];
  assert.strictEqual(row.agentId, 'activation');
  assert.strictEqual(row.decisionType, 'nudge');
  assert.strictEqual(row.institutionId, INST);
  assert.strictEqual(row.cohortId, COHORT);
  assert.strictEqual(row.action.kind, 'activation_reminder_batch');
  assert.strictEqual(row.promptVersion, 'activation-v1');
  assert.strictEqual(row.reminderGapDays === undefined, true); // lives under action, not top-level
  assert.strictEqual(row.action.reminderGapDays, 3);
  assert.strictEqual(row.action.maxReminders, 3);
  assert.ok(row.action.stats);
}));

test('runDaily: per-cohort failure isolation — one cohort throws, the other still records', () => withEnv(ENV, async () => {
  const goodStudent = student({ name: 'good', createdAt: daysAgo(30), cohortId: 'cohort-good' });
  goodStudent.save = async function () { this._saved = (this._saved || 0) + 1; };
  const recorded = [];
  let calls = 0;
  const deps = baseDeps({
    listCandidateCohorts: async () => [
      { institutionId: INST, cohortId: 'cohort-bad' },
      { institutionId: INST, cohortId: 'cohort-good' },
    ],
    PendingStudent: {
      find: async (filter) => {
        calls += 1;
        if (filter.cohortId === 'cohort-bad') throw new Error('DB blew up for this cohort');
        return [goodStudent].filter((s) => matchesFilter(s, filter));
      },
      countDocuments: async (filter) => [goodStudent].filter((s) => matchesFilter(s, filter)).length,
    },
    record: async (payload) => recorded.push(payload),
  });
  const result = await runDaily(deps);
  assert.ok(calls >= 2);
  assert.strictEqual(result.cohorts, 1);
  assert.strictEqual(recorded.length, 1);
  assert.strictEqual(recorded[0].cohortId, 'cohort-good');
}));

// ── getFunnel ────────────────────────────────────────────────────────────

test('getFunnel: invited/claimed/exhausted counts + claimRate math', () => withEnv(ENV, async () => {
  const students = [
    student({ name: 'i1', status: 'invited' }),
    student({ name: 'i2', status: 'invited' }),
    student({ name: 'c1', status: 'claimed' }),
    student({ name: 'exh', status: 'invited', remindersSent: 3 }),
  ];
  const deps = baseDeps({
    PendingStudent: makePendingStudentModel(students),
    AgentDecision: { findOne: () => ({ sort: async () => null }) },
  });
  const funnel = await getFunnel({ institutionId: INST, cohortId: COHORT }, deps);
  assert.strictEqual(funnel.invited, 3); // i1, i2, exh — all still 'invited' status
  assert.strictEqual(funnel.claimed, 1);
  assert.strictEqual(funnel.exhausted, 1);
  assert.strictEqual(funnel.claimRate, 1 / 4);
}));

test('getFunnel: zero invites + zero claims -> claimRate is 0, not NaN/Infinity', () => withEnv(ENV, async () => {
  const deps = baseDeps({
    PendingStudent: makePendingStudentModel([]),
    AgentDecision: { findOne: () => ({ sort: async () => null }) },
  });
  const funnel = await getFunnel({ institutionId: INST, cohortId: COHORT }, deps);
  assert.strictEqual(funnel.invited, 0);
  assert.strictEqual(funnel.claimed, 0);
  assert.strictEqual(funnel.claimRate, 0);
  assert.strictEqual(funnel.exhausted, 0);
  assert.strictEqual(funnel.lastBatch, null);
}));

test('getFunnel: lastBatch returns the latest activation row\'s action.stats', () => withEnv(ENV, async () => {
  const latestStats = { invited: 2, claimed: 1, reminded: 1, exhausted: 0, invalid: 0 };
  const deps = baseDeps({
    PendingStudent: makePendingStudentModel([]),
    AgentDecision: { findOne: () => ({ sort: async () => ({ action: { kind: 'activation_reminder_batch', stats: latestStats } }) }) },
  });
  const funnel = await getFunnel({ institutionId: INST, cohortId: COHORT }, deps);
  assert.deepStrictEqual(funnel.lastBatch, latestStats);
}));
