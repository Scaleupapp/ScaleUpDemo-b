// src/services/misconceptionService.recheck.test.js
//
// #7 — misconception spaced re-checks. Pure-function + DI-fake coverage,
// zero DB. Follows the DI seam convention used elsewhere in the agentic
// layer (see src/workers/recalibrationOfferWorker.js / .test.js).
'use strict';

const { test } = require('node:test');
const assert = require('assert');

const svc = require('./misconceptionService');
const { advanceReview, getDueReviews, recordFromAttempt, REVIEW_INTERVALS } = svc;

const DAY_MS = 86400000;

// ---- fakes (no DB) ------------------------------------------------------

function fakeLedgerModel(doc) {
  return {
    findOne: async () => doc,
  };
}

function fakeLedgerModelLean(doc) {
  return {
    findOne: () => ({
      lean: async () => doc,
    }),
  };
}

// Simulates Mongoose DocumentArray casting behavior (verified against
// mongoose 8.23.1): `entries.push(plainObject)` casts the argument into a
// brand-new subdocument rather than storing the reference passed in. Code
// that keeps a local `entry` variable and mutates it AFTER push() is
// silently writing to a detached object — those mutations never reach the
// stored subdocument and get dropped on save.
//
// A plain Array.push keeps reference identity (push(obj) stores obj itself)
// and would NOT catch this bug class. This wrapper clones on push so a
// future push-then-mutate regression fails a test instead of shipping.
function makeDocumentArray(initial = []) {
  const arr = initial.map((e) => ({ ...e }));
  arr.push = (...items) => Array.prototype.push.apply(arr, items.map((item) => ({ ...item })));
  return arr;
}

function makeQuiz({ topic = 'algebra', concept = 'linear-equations', tag = 'sign_flip_error' } = {}) {
  return {
    topic,
    questions: [
      {
        concept,
        options: [
          { label: 'A', isCorrect: true },
          { label: 'B', isCorrect: false, misconception: { tag, explanation: 'flips the sign incorrectly' } },
        ],
      },
    ],
  };
}

// ==========================================================================
// advanceReview — pure mutator
// ==========================================================================

test('advanceReview: not-due (nextReviewAt in the future) is a no-op', () => {
  const now = new Date('2026-07-12T00:00:00Z');
  const item = { reviewStage: 0, nextReviewAt: new Date(now.getTime() + DAY_MS), closedAt: null };
  const result = advanceReview(item, now);
  assert.deepStrictEqual(result, { advanced: false, closed: false });
  assert.strictEqual(item.reviewStage, 0);
});

test('advanceReview: exactly-now boundary counts as DUE (inclusive)', () => {
  // Documented choice: nextReviewAt === now is due, not "not yet". Mirrors
  // the $lte: now convention used elsewhere (spacedRepetitionService).
  const now = new Date('2026-07-12T00:00:00Z');
  const item = { reviewStage: 0, nextReviewAt: new Date(now.getTime()), closedAt: null };
  const result = advanceReview(item, now);
  assert.deepStrictEqual(result, { advanced: true, closed: false });
  assert.strictEqual(item.reviewStage, 1);
});

test('advanceReview: due item advances stage and sets the correct next interval', () => {
  const now = new Date('2026-07-12T00:00:00Z');
  const item = { reviewStage: 0, nextReviewAt: new Date(now.getTime() - 1000), closedAt: null };
  const result = advanceReview(item, now);
  assert.deepStrictEqual(result, { advanced: true, closed: false });
  assert.strictEqual(item.reviewStage, 1);
  assert.strictEqual(item.nextReviewAt.getTime(), now.getTime() + REVIEW_INTERVALS[1] * DAY_MS);
  assert.strictEqual(item.closedAt, null);
});

test('advanceReview: reaching the final stage closes the item', () => {
  const now = new Date('2026-07-12T00:00:00Z');
  const item = { reviewStage: REVIEW_INTERVALS.length - 1, nextReviewAt: new Date(now.getTime() - 1000), closedAt: null };
  const result = advanceReview(item, now);
  assert.deepStrictEqual(result, { advanced: true, closed: true });
  assert.strictEqual(item.reviewStage, REVIEW_INTERVALS.length);
  assert.strictEqual(item.closedAt, now);
  assert.strictEqual(item.nextReviewAt, null);
});

test('advanceReview: closed item is a no-op even if "due"', () => {
  const now = new Date('2026-07-12T00:00:00Z');
  const item = { reviewStage: 3, nextReviewAt: null, closedAt: new Date(now.getTime() - DAY_MS) };
  const result = advanceReview(item, now);
  assert.deepStrictEqual(result, { advanced: false, closed: false });
  assert.strictEqual(item.reviewStage, 3);
});

test('advanceReview: item with no nextReviewAt scheduled is a no-op', () => {
  // Guards legacy/never-scheduled entries from being silently advanced.
  const now = new Date('2026-07-12T00:00:00Z');
  const item = { reviewStage: 0, nextReviewAt: undefined, closedAt: null };
  const result = advanceReview(item, now);
  assert.deepStrictEqual(result, { advanced: false, closed: false });
});

// ==========================================================================
// getDueReviews
// ==========================================================================

test('getDueReviews: returns only open, due items, oldest nextReviewAt first, mapped fields', async () => {
  const now = Date.now();
  const doc = {
    entries: [
      { tag: 'closed_tag', reviewStage: 3, closedAt: new Date(now - DAY_MS), nextReviewAt: null },
      { tag: 'not_due_tag', reviewStage: 0, closedAt: null, nextReviewAt: new Date(now + DAY_MS) },
      { tag: 'due_recent', reviewStage: 1, closedAt: null, nextReviewAt: new Date(now - 1000), recentTopic: 't1', recentExplanation: 'exp1' },
      { tag: 'due_oldest', reviewStage: 0, closedAt: null, nextReviewAt: new Date(now - 5 * DAY_MS), recentTopic: 't2', recentExplanation: 'exp2' },
    ],
  };

  const due = await getDueReviews('u1', 5, { MisconceptionLedger: fakeLedgerModelLean(doc) });
  assert.strictEqual(due.length, 2);
  assert.deepStrictEqual(due.map(d => d.tag), ['due_oldest', 'due_recent']);
  assert.deepStrictEqual(due[0], {
    tag: 'due_oldest',
    recentTopic: 't2',
    recentExplanation: 'exp2',
    reviewStage: 0,
    nextReviewAt: doc.entries[3].nextReviewAt,
  });
});

test('getDueReviews: respects the limit', async () => {
  const now = Date.now();
  const doc = {
    entries: [
      { tag: 'a', closedAt: null, nextReviewAt: new Date(now - 3000) },
      { tag: 'b', closedAt: null, nextReviewAt: new Date(now - 2000) },
      { tag: 'c', closedAt: null, nextReviewAt: new Date(now - 1000) },
    ],
  };
  const due = await getDueReviews('u1', 2, { MisconceptionLedger: fakeLedgerModelLean(doc) });
  assert.strictEqual(due.length, 2);
  assert.deepStrictEqual(due.map(d => d.tag), ['a', 'b']);
});

test('getDueReviews: empty ledger returns []', async () => {
  const due = await getDueReviews('u1', 2, { MisconceptionLedger: fakeLedgerModelLean(null) });
  assert.deepStrictEqual(due, []);
});

// ==========================================================================
// recordFromAttempt — #7 extension
// ==========================================================================

test('recordFromAttempt: a firing tag schedules the first re-check (day 2)', async () => {
  // entries uses the DocumentArray-casting fake: push(entry) stores a
  // CLONE, so any post-push mutation of the local `entry` reference in
  // recordFromAttempt would be silently lost here — exactly like the real
  // mongoose bug this test guards against.
  const ledgerDoc = { userId: 'u1', entries: makeDocumentArray([]), totalMisconceptionsTracked: 0, save: async function () { this._saved = true; return this; } };
  const quiz = makeQuiz();
  const attempt = { userId: 'u1', answers: [{ questionIndex: 0, selectedAnswer: 'B', isCorrect: false }] };
  const recordCalls = [];

  const before = Date.now();
  await recordFromAttempt('u1', attempt, quiz, {
    MisconceptionLedger: fakeLedgerModel(ledgerDoc),
    record: async (p) => recordCalls.push(p),
    isAgentEnabled: () => true,
  });
  const after = Date.now();

  assert.strictEqual(ledgerDoc.entries.length, 1);
  // Assert against the STORED entry (ledger.entries[0]) — the cast clone —
  // not any local reference the implementation may still be holding.
  const stored = ledgerDoc.entries[0];
  assert.strictEqual(stored.tag, 'sign_flip_error');
  assert.strictEqual(stored.count, 1); // incremented on the stored subdoc
  assert.strictEqual(stored.reviewStage, 0);
  assert.strictEqual(stored.closedAt, null);
  assert.ok(stored.nextReviewAt instanceof Date, 'nextReviewAt must be set on the stored entry');
  assert.ok(stored.nextReviewAt.getTime() >= before + REVIEW_INTERVALS[0] * DAY_MS);
  assert.ok(stored.nextReviewAt.getTime() <= after + REVIEW_INTERVALS[0] * DAY_MS);
  assert.ok(stored.lastSeenAt instanceof Date, 'lastSeenAt must be set on the stored entry');
  assert.strictEqual(ledgerDoc._saved, true);
  assert.strictEqual(recordCalls.length, 0); // opening isn't recorded, only closure
});

test('recordFromAttempt: recurrence reopens a previously closed tag', async () => {
  const ledgerDoc = {
    userId: 'u1',
    entries: [{ tag: 'sign_flip_error', count: 5, reviewStage: 3, closedAt: new Date(Date.now() - DAY_MS), nextReviewAt: null, topicsAffected: ['linear-equations'], recentTopic: 'linear-equations' }],
    totalMisconceptionsTracked: 5,
    save: async function () { this._saved = true; return this; },
  };
  const quiz = makeQuiz();
  const attempt = { userId: 'u1', answers: [{ questionIndex: 0, selectedAnswer: 'B', isCorrect: false }] };

  await recordFromAttempt('u1', attempt, quiz, {
    MisconceptionLedger: fakeLedgerModel(ledgerDoc),
    record: async () => {},
    isAgentEnabled: () => true,
  });

  const entry = ledgerDoc.entries[0];
  assert.strictEqual(entry.reviewStage, 0);
  assert.strictEqual(entry.closedAt, null);
  assert.ok(entry.nextReviewAt instanceof Date);
});

test('recordFromAttempt: topic touched without the tag firing advances the review clock', async () => {
  const ledgerDoc = {
    userId: 'u1',
    entries: [{
      tag: 'sign_flip_error', count: 3, reviewStage: 0, closedAt: null,
      nextReviewAt: new Date(Date.now() - 1000), // due
      topicsAffected: ['linear-equations'], recentTopic: 'linear-equations',
    }],
    totalMisconceptionsTracked: 3,
    save: async function () { this._saved = true; return this; },
  };
  const quiz = makeQuiz();
  // This time the learner answers correctly — no firing — but the topic matches.
  const attempt = { userId: 'u1', answers: [{ questionIndex: 0, selectedAnswer: 'A', isCorrect: true }] };
  const recordCalls = [];

  await recordFromAttempt('u1', attempt, quiz, {
    MisconceptionLedger: fakeLedgerModel(ledgerDoc),
    record: async (p) => recordCalls.push(p),
    isAgentEnabled: () => true,
  });

  const entry = ledgerDoc.entries[0];
  assert.strictEqual(entry.reviewStage, 1);
  assert.strictEqual(entry.closedAt, null);
  assert.strictEqual(ledgerDoc._saved, true);
  assert.strictEqual(recordCalls.length, 0); // not closed yet
});

test('recordFromAttempt: closing the final stage records a misconception_closed decision', async () => {
  const ledgerDoc = {
    userId: 'u1',
    entries: [{
      tag: 'sign_flip_error', count: 4, reviewStage: REVIEW_INTERVALS.length - 1, closedAt: null,
      nextReviewAt: new Date(Date.now() - 1000),
      topicsAffected: ['linear-equations'], recentTopic: 'linear-equations',
    }],
    totalMisconceptionsTracked: 4,
    save: async function () { this._saved = true; return this; },
  };
  const quiz = makeQuiz();
  const attempt = { userId: 'u1', answers: [{ questionIndex: 0, selectedAnswer: 'A', isCorrect: true }] };
  const recordCalls = [];

  await recordFromAttempt('u1', attempt, quiz, {
    MisconceptionLedger: fakeLedgerModel(ledgerDoc),
    record: async (p) => recordCalls.push(p),
    isAgentEnabled: () => true,
  });

  const entry = ledgerDoc.entries[0];
  assert.strictEqual(entry.reviewStage, REVIEW_INTERVALS.length);
  assert.ok(entry.closedAt instanceof Date);
  assert.strictEqual(entry.nextReviewAt, null);

  assert.strictEqual(recordCalls.length, 1);
  assert.deepStrictEqual(recordCalls[0], {
    agentId: 'misconception_tutor',
    decisionType: 'recommendation',
    userId: 'u1',
    action: { kind: 'misconception_closed', tag: 'sign_flip_error', stagesPassed: REVIEW_INTERVALS.length },
    promptVersion: 'miscon-v1',
  });
});

test('recordFromAttempt: closure record failure is swallowed (ledger save already happened)', async () => {
  const ledgerDoc = {
    userId: 'u1',
    entries: [{
      tag: 'sign_flip_error', count: 4, reviewStage: REVIEW_INTERVALS.length - 1, closedAt: null,
      nextReviewAt: new Date(Date.now() - 1000),
      topicsAffected: ['linear-equations'], recentTopic: 'linear-equations',
    }],
    totalMisconceptionsTracked: 4,
    save: async function () { this._saved = true; return this; },
  };
  const quiz = makeQuiz();
  const attempt = { userId: 'u1', answers: [{ questionIndex: 0, selectedAnswer: 'A', isCorrect: true }] };

  await assert.doesNotReject(() => recordFromAttempt('u1', attempt, quiz, {
    MisconceptionLedger: fakeLedgerModel(ledgerDoc),
    record: async () => { throw new Error('ledger write down'); },
    isAgentEnabled: () => true,
  }));

  assert.strictEqual(ledgerDoc._saved, true);
  assert.ok(ledgerDoc.entries[0].closedAt instanceof Date);
});

test('recordFromAttempt: flag off leaves behavior byte-identical to pre-#7 code', async () => {
  // Two distinct tags on the same topic: one already tracked and "due" for
  // review, one that fires fresh this attempt. With the flag off, neither
  // should gain any #7 field, and the due-but-untouched entry must not be
  // silently advanced just because its topic came up.
  const existingDueDate = new Date(Date.now() - 1000);
  const ledgerDoc = {
    userId: 'u1',
    entries: makeDocumentArray([{
      tag: 'unit_confusion', count: 3, reviewStage: 0, closedAt: null,
      nextReviewAt: existingDueDate,
      topicsAffected: ['linear-equations'], recentTopic: 'linear-equations',
    }]),
    totalMisconceptionsTracked: 3,
    save: async function () { this._saved = true; return this; },
  };
  const quiz = {
    topic: 'algebra',
    questions: [
      { concept: 'linear-equations', options: [
        { label: 'A', isCorrect: true },
        { label: 'B', isCorrect: false, misconception: { tag: 'sign_flip_error', explanation: 'flips the sign' } },
      ] },
      { concept: 'linear-equations', options: [
        { label: 'A', isCorrect: true },
        { label: 'B', isCorrect: false, misconception: { tag: 'unit_confusion', explanation: 'mixes units' } },
      ] },
    ],
  };
  // Q0 fires a NEW tag. Q1 is answered correctly — touches unit_confusion's
  // topic without firing it, which WOULD advance it if the flag were on.
  const attempt = {
    userId: 'u1',
    answers: [
      { questionIndex: 0, selectedAnswer: 'B', isCorrect: false },
      { questionIndex: 1, selectedAnswer: 'A', isCorrect: true },
    ],
  };
  const recordCalls = [];

  await recordFromAttempt('u1', attempt, quiz, {
    MisconceptionLedger: fakeLedgerModel(ledgerDoc),
    record: async (p) => recordCalls.push(p),
    isAgentEnabled: () => false,
  });

  // The pre-existing entry (topic touched, but flag is off) must be untouched.
  const existing = ledgerDoc.entries.find(e => e.tag === 'unit_confusion');
  assert.strictEqual(existing.reviewStage, 0);
  assert.strictEqual(existing.closedAt, null);
  assert.strictEqual(existing.nextReviewAt, existingDueDate); // not advanced

  // The firing tag gets the pre-#7 fields only — no reviewStage/nextReviewAt/closedAt set by us.
  const firedEntry = ledgerDoc.entries.find(e => e.tag === 'sign_flip_error');
  assert.strictEqual(firedEntry.count, 1);
  assert.strictEqual('nextReviewAt' in firedEntry, false);
  assert.strictEqual('closedAt' in firedEntry, false);
  assert.strictEqual('reviewStage' in firedEntry, false);

  assert.strictEqual(recordCalls.length, 0);
  assert.strictEqual(ledgerDoc._saved, true); // still saves — firing itself is pre-#7 behavior
});

test('recordFromAttempt: flag on, no firing, no ledger yet — no-op (no spurious ledger creation)', async () => {
  let findOneCalls = 0;
  const LedgerModel = {
    findOne: async () => { findOneCalls++; return null; },
  };
  const quiz = makeQuiz();
  const attempt = { userId: 'u1', answers: [{ questionIndex: 0, selectedAnswer: 'A', isCorrect: true }] };

  await recordFromAttempt('u1', attempt, quiz, {
    MisconceptionLedger: LedgerModel,
    record: async () => { throw new Error('should not be called'); },
    isAgentEnabled: () => true,
  });

  assert.strictEqual(findOneCalls, 1);
});
