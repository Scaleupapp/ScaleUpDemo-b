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

// Applies a $set with dot-path support (e.g. 'contextSnapshot.approvedBy')
// onto a plain object, mirroring what a real MongoDB $set update does.
function applyDotSet(target, setFields) {
  for (const [path, value] of Object.entries(setFields)) {
    const parts = path.split('.');
    let cursor = target;
    for (let i = 0; i < parts.length - 1; i += 1) {
      cursor[parts[i]] = cursor[parts[i]] || {};
      cursor = cursor[parts[i]];
    }
    cursor[parts[parts.length - 1]] = value;
  }
}

function makeAgentDecisionModel(row) {
  return {
    findOneAndUpdateCalls: [],
    async findOne(query) {
      if (!row) return null;
      if (String(query._id) !== String(row._id)) return null;
      if (query.agentId !== 'intervention') return null;
      if (String(query.institutionId) !== String(row.institutionId)) return null;
      return row;
    },
    async findOneAndUpdate(filter, update) {
      this.findOneAndUpdateCalls.push({ filter, update });
      if (!row) return null;
      if (String(filter._id) !== String(row._id)) return null;
      if (filter.agentId !== 'intervention') return null;
      if (String(filter.institutionId) !== String(row.institutionId)) return null;
      if (filter.status && row.status !== filter.status) return null;
      applyDotSet(row, update.$set);
      return row;
    },
  };
}

/**
 * A model fake whose findOne returns a FRESH SNAPSHOT decoupled from the
 * underlying store (like a real DB read), while findOneAndUpdate mutates a
 * single shared store atomically — lets a test genuinely exercise the
 * double-submit race for approveBrief.
 */
function makeAgentDecisionStoreModel(initialRow) {
  const store = { ...initialRow, action: initialRow.action };
  return {
    store,
    async findOne(query) {
      if (String(query._id) !== String(store._id)) return null;
      if (query.agentId !== 'intervention') return null;
      if (String(query.institutionId) !== String(store.institutionId)) return null;
      return { ...store };
    },
    async findOneAndUpdate(filter, update) {
      if (String(filter._id) !== String(store._id)) return null;
      if (filter.agentId !== 'intervention') return null;
      if (String(filter.institutionId) !== String(store.institutionId)) return null;
      if (filter.status && store.status !== filter.status) return null;
      applyDotSet(store, update.$set);
      return { ...store };
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
  // The close is now an atomic findOneAndUpdate claim, not save() —
  // saveCalls stays undefined because save() is never invoked.
  assert.strictEqual(row.saveCalls, undefined);
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

test('approveBrief: stamps contextSnapshot.approvedBy via the atomic claim before any notification fires', async () => {
  const row = makeDecisionDoc();
  const notificationService = makeNotificationService();
  const model = makeAgentDecisionModel(row);
  await approveBrief(
    { decisionId: 'dec1', institutionId: 'inst1', actorInstitutionUserId: 'iu-head-1', clusterKeys: ['not_started', 'inactive'] },
    { AgentDecision: model, notificationService }
  );

  assert.strictEqual(row.contextSnapshot.approvedBy, 'iu-head-1');
  assert.ok(row.respondedAt instanceof Date);
  assert.strictEqual(model.findOneAndUpdateCalls.length, 1);
  assert.strictEqual(
    model.findOneAndUpdateCalls[0].update.$set['contextSnapshot.approvedBy'],
    'iu-head-1',
    'the approvedBy stamp must be set via a dot-path so it cannot clobber the rest of contextSnapshot'
  );
});

test('approveBrief: claims the row atomically BEFORE any notification fires', async () => {
  const row = makeDecisionDoc();
  const notifyOrder = [];
  const model = makeAgentDecisionModel(row);
  const originalFindOneAndUpdate = model.findOneAndUpdate.bind(model);
  model.findOneAndUpdate = async (...args) => {
    notifyOrder.push('claim');
    return originalFindOneAndUpdate(...args);
  };
  const notificationService = {
    calls: [],
    async createInApp(userId, payload) {
      notifyOrder.push('notify');
      this.calls.push({ userId, ...payload });
      return { _id: `notif-${userId}` };
    },
  };

  await approveBrief(
    { decisionId: 'dec1', institutionId: 'inst1', actorInstitutionUserId: 'iu1', clusterKeys: ['not_started', 'inactive'] },
    { AgentDecision: model, notificationService }
  );

  assert.deepStrictEqual(notifyOrder, ['claim', 'notify', 'notify', 'notify']);
});

test('approveBrief: concurrent double-submit only claims once — the loser gets "brief already resolved" and sends no notifications', async () => {
  const row = makeDecisionDoc();
  const model = makeAgentDecisionStoreModel(row);
  const notificationServiceA = makeNotificationService();
  const notificationServiceB = makeNotificationService();

  const args = { decisionId: 'dec1', institutionId: 'inst1', actorInstitutionUserId: 'iu1', clusterKeys: ['not_started', 'inactive'] };
  const results = await Promise.allSettled([
    approveBrief(args, { AgentDecision: model, notificationService: notificationServiceA }),
    approveBrief(args, { AgentDecision: model, notificationService: notificationServiceB }),
  ]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.strictEqual(fulfilled.length, 1, 'exactly one concurrent call must win the claim');
  assert.strictEqual(rejected.length, 1);
  assert.match(rejected[0].reason.message, /brief already resolved/);

  const totalNotified = notificationServiceA.calls.length + notificationServiceB.calls.length;
  assert.strictEqual(totalNotified, 3, 'students must be notified exactly once, not twice');
  assert.strictEqual(model.store.status, 'accepted');
});
