'use strict';

const { test } = require('node:test');
const assert = require('assert');

const { approveBrief } = require('./briefApprovalService');

// ── Fakes ────────────────────────────────────────────────────────────────

/** One decision row: { action, markModified(k), save() } — save/markModified are spied. */
function makeDecisionDoc(overrides = {}) {
  return {
    _id: 'dec1',
    institutionId: 'inst1',
    status: 'pending',
    contextSnapshot: undefined,
    action: {
      kind: 'cohort_intervention_brief',
      cohortLabel: 'Cohort A',
      clusters: [
        {
          key: 'not_started',
          label: 'Not started',
          studentIds: ['s1', 's2'],
          evidence: { notStartedCount: 2 },
          proposedAction: { kind: 'notify_students', payload: { title: 'Start now', message: 'Go start it' } },
        },
        {
          key: 'inactive',
          label: 'Inactive',
          studentIds: ['s3'],
          evidence: { inactiveCount: 1 },
          proposedAction: { kind: 'notify_students', payload: { title: 'Come back', message: 'We miss you' } },
        },
      ],
    },
    markModified(key) {
      this.marked = (this.marked || []).concat(key);
    },
    async save() {
      this.saveCalls = (this.saveCalls || 0) + 1;
      this.markedBeforeSave = (this.marked || []).slice();
    },
    ...overrides,
  };
}

function makeAgentDecisionModel(row) {
  return {
    async findOne(query) {
      if (!row) return null;
      if (String(query._id) !== String(row._id)) return null;
      if (query.agentId !== 'intervention') return null;
      if (String(query.institutionId) !== String(row.institutionId)) return null;
      return row;
    },
  };
}

function makeNotificationService({ failFor = new Set() } = {}) {
  const calls = [];
  return {
    calls,
    async createInApp(userId, payload) {
      calls.push({ userId, ...payload });
      if (failFor.has(userId)) throw new Error('notify failed');
      return { _id: `notif-${userId}` };
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

test('approveBrief: full-set approval -> accepted + all students notified', async () => {
  const row = makeDecisionDoc();
  const notificationService = makeNotificationService();
  const result = await approveBrief(
    { decisionId: 'dec1', institutionId: 'inst1', actorInstitutionUserId: 'iu1', clusterKeys: ['not_started', 'inactive'] },
    { AgentDecision: makeAgentDecisionModel(row), notificationService }
  );

  assert.deepStrictEqual(result, { executed: { notified: 3 }, status: 'accepted' });
  assert.strictEqual(row.status, 'accepted');
  assert.strictEqual(notificationService.calls.length, 3);
  assert.ok(notificationService.calls.every((c) => c.type === 'cohort_intervention'));
  assert.strictEqual(row.saveCalls, 1);
});

test('approveBrief: subset approval -> adjusted + adjustmentDiff.approvedClusterKeys', async () => {
  const row = makeDecisionDoc();
  const notificationService = makeNotificationService();
  const result = await approveBrief(
    { decisionId: 'dec1', institutionId: 'inst1', actorInstitutionUserId: 'iu1', clusterKeys: ['not_started'] },
    { AgentDecision: makeAgentDecisionModel(row), notificationService }
  );

  assert.deepStrictEqual(result, { executed: { notified: 2 }, status: 'adjusted' });
  assert.strictEqual(row.status, 'adjusted');
  assert.deepStrictEqual(row.adjustmentDiff, { approvedClusterKeys: ['not_started'] });
  assert.strictEqual(notificationService.calls.length, 2);
});

test('approveBrief: unknown cluster key rejects before any notification fires', async () => {
  const row = makeDecisionDoc();
  const notificationService = makeNotificationService();
  await assert.rejects(
    approveBrief(
      { decisionId: 'dec1', institutionId: 'inst1', actorInstitutionUserId: 'iu1', clusterKeys: ['not_started', 'bogus'] },
      { AgentDecision: makeAgentDecisionModel(row), notificationService }
    ),
    /unsupported cluster key: bogus/
  );
  assert.strictEqual(notificationService.calls.length, 0, 'no notification should fire when validation fails');
  assert.strictEqual(row.status, 'pending', 'row must remain untouched');
  assert.strictEqual(row.saveCalls, undefined);
});

test('approveBrief: per-student notify failure is caught and counted-continues', async () => {
  const row = makeDecisionDoc();
  const notificationService = makeNotificationService({ failFor: new Set(['s1']) });
  const result = await approveBrief(
    { decisionId: 'dec1', institutionId: 'inst1', actorInstitutionUserId: 'iu1', clusterKeys: ['not_started'] },
    { AgentDecision: makeAgentDecisionModel(row), notificationService }
  );

  // s1 fails, s2 succeeds -> notified counts only the successful one.
  assert.strictEqual(result.executed.notified, 1);
  assert.strictEqual(notificationService.calls.length, 2, 'both students were attempted');
  assert.strictEqual(row.status, 'adjusted');
});

test('approveBrief: wrong institution -> "brief not found"', async () => {
  const row = makeDecisionDoc({ institutionId: 'inst1' });
  const notificationService = makeNotificationService();
  await assert.rejects(
    approveBrief(
      { decisionId: 'dec1', institutionId: 'inst-other', actorInstitutionUserId: 'iu1', clusterKeys: ['not_started'] },
      { AgentDecision: makeAgentDecisionModel(row), notificationService }
    ),
    /brief not found/
  );
  assert.strictEqual(notificationService.calls.length, 0);
});

test('approveBrief: non-pending row -> "brief already <status>"', async () => {
  const row = makeDecisionDoc({ status: 'accepted' });
  const notificationService = makeNotificationService();
  await assert.rejects(
    approveBrief(
      { decisionId: 'dec1', institutionId: 'inst1', actorInstitutionUserId: 'iu1', clusterKeys: ['not_started'] },
      { AgentDecision: makeAgentDecisionModel(row), notificationService }
    ),
    /brief already accepted/
  );
  assert.strictEqual(notificationService.calls.length, 0);
});

test('approveBrief: stamps contextSnapshot.approvedBy and calls markModified("contextSnapshot") before save', async () => {
  const row = makeDecisionDoc();
  const notificationService = makeNotificationService();
  await approveBrief(
    { decisionId: 'dec1', institutionId: 'inst1', actorInstitutionUserId: 'iu-head-1', clusterKeys: ['not_started', 'inactive'] },
    { AgentDecision: makeAgentDecisionModel(row), notificationService }
  );

  assert.strictEqual(row.contextSnapshot.approvedBy, 'iu-head-1');
  assert.ok(row.markedBeforeSave.includes('contextSnapshot'), 'markModified("contextSnapshot") must precede save()');
  assert.ok(row.respondedAt instanceof Date);
});
