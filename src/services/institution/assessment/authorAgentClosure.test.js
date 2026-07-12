'use strict';

const { test } = require('node:test');
const assert = require('assert');

const { closeOnLifecycle } = require('./authorAgentClosure');

// ── Fakes ────────────────────────────────────────────────────────────────

/** One decision row: status/adjustmentDiff/respondedAt mutated in place; save() spied. */
function makeDecisionDoc(overrides = {}) {
  return {
    _id: 'dec1',
    agentId: 'author_agent',
    status: 'pending',
    action: { kind: 'assessment_authoring_run', assessmentId: 'a1' },
    async save() {
      this.saveCalls = (this.saveCalls || 0) + 1;
    },
    ...overrides,
  };
}

/** Fake AgentDecision model: findOne(query) returns a chainable { sort() } that resolves to a row (or null). */
function makeAgentDecisionModel({ row = null, findOneCalls = [] } = {}) {
  return {
    findOne(query) {
      findOneCalls.push(query);
      return {
        sort() {
          return Promise.resolve(row);
        },
      };
    },
  };
}

function baseDeps({ row, isAgentEnabled = () => true, findOneCalls = [] } = {}) {
  return {
    AgentDecision: makeAgentDecisionModel({ row, findOneCalls }),
    isAgentEnabled,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

test('released with zero edits accepts the pending row', async () => {
  const row = makeDecisionDoc();
  const deps = baseDeps({ row });

  const result = await closeOnLifecycle({ assessmentId: 'a1', event: 'released', editedQuestionCount: 0 }, deps);

  assert.deepStrictEqual(result, { closed: true });
  assert.strictEqual(row.status, 'accepted');
  assert.strictEqual(row.adjustmentDiff, undefined);
  assert.ok(row.respondedAt instanceof Date);
  assert.strictEqual(row.saveCalls, 1);
});

test('released with edits marks the row adjusted with adjustmentDiff', async () => {
  const row = makeDecisionDoc();
  const deps = baseDeps({ row });

  const result = await closeOnLifecycle({ assessmentId: 'a1', event: 'released', editedQuestionCount: 3 }, deps);

  assert.deepStrictEqual(result, { closed: true });
  assert.strictEqual(row.status, 'adjusted');
  assert.deepStrictEqual(row.adjustmentDiff, { editedQuestionCount: 3 });
  assert.ok(row.respondedAt instanceof Date);
  assert.strictEqual(row.saveCalls, 1);
});

test('deleted rejects the pending row', async () => {
  const row = makeDecisionDoc();
  const deps = baseDeps({ row });

  const result = await closeOnLifecycle({ assessmentId: 'a1', event: 'deleted' }, deps);

  assert.deepStrictEqual(result, { closed: true });
  assert.strictEqual(row.status, 'rejected');
  assert.ok(row.respondedAt instanceof Date);
  assert.strictEqual(row.saveCalls, 1);
});

test('no pending row is a silent no-op', async () => {
  const deps = baseDeps({ row: null });

  const result = await closeOnLifecycle({ assessmentId: 'a1', event: 'released', editedQuestionCount: 0 }, deps);

  assert.deepStrictEqual(result, { closed: false });
});

test('flag off is a no-op and never queries AgentDecision', async () => {
  const findOneCalls = [];
  const deps = baseDeps({ row: makeDecisionDoc(), isAgentEnabled: () => false, findOneCalls });

  const result = await closeOnLifecycle({ assessmentId: 'a1', event: 'released', editedQuestionCount: 0 }, deps);

  assert.deepStrictEqual(result, { closed: false });
  assert.strictEqual(findOneCalls.length, 0);
});

test('unknown event throws', async () => {
  const deps = baseDeps({ row: makeDecisionDoc() });

  await assert.rejects(
    () => closeOnLifecycle({ assessmentId: 'a1', event: 'archived', editedQuestionCount: 0 }, deps),
    /unsupported event: archived/
  );
});
