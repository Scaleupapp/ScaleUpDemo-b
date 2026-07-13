'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runDaily } = require('./sentinelService');

const NOW = new Date('2026-07-13T00:00:00.000Z');

// ── LLMSpend aggregate fake ─────────────────────────────────────────────────
// The service issues four distinct aggregate() pipelines against LLMSpend:
//   1. zero-cost:   $match has cost_usd: 0                    -> group by $model
//   2. spike 24h:   $match createdAt >= ~1 day ago             -> group by $task_id
//   3. spike 30d:   $match createdAt >= ~30 days ago            -> group by $task_id
//   4. model inv:   $match createdAt >= ~1 day ago (no cost_usd)-> group by $model
// This fake dispatches on those pipeline shapes so tests exercise the real
// pipeline the service builds, not just canned call-order sequencing.
function makeLLMSpend({ zeroCostRows = [], spike24hRows = [], spike30dRows = [], modelRows = [], throwOn } = {}) {
  const midpoint = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000);
  return {
    aggregate: async (pipeline) => {
      const match = (pipeline.find((s) => s.$match) || {}).$match || {};
      const group = (pipeline.find((s) => s.$group) || {}).$group || {};

      if (match.cost_usd === 0) {
        if (throwOn === 'zero_cost') throw new Error('zero-cost aggregate failed');
        return zeroCostRows;
      }
      if (group._id === '$task_id') {
        const gte = match.createdAt && match.createdAt.$gte;
        const isRecent = gte instanceof Date && gte.getTime() > midpoint.getTime();
        if (throwOn === 'spend_spike') throw new Error('spend-spike aggregate failed');
        return isRecent ? spike24hRows : spike30dRows;
      }
      if (group._id === '$model') {
        if (throwOn === 'model_inventory') throw new Error('model-inventory aggregate failed');
        return modelRows;
      }
      return [];
    },
  };
}

function makeAgentDecisionModel({ reportRows = [], throwOn } = {}) {
  return {
    aggregate: async () => {
      if (throwOn === 'agent_report_card') throw new Error('report-card aggregate failed');
      return reportRows;
    },
  };
}

function baseDeps(overrides = {}) {
  const recordCalls = overrides.recordCalls || [];
  const fireCalls = overrides.fireCalls || [];

  return {
    LLMSpend: overrides.LLMSpend || makeLLMSpend(overrides.llmSpendFixture || {}),
    AgentDecision: overrides.AgentDecision || makeAgentDecisionModel(overrides.reportCardFixture || {}),
    alerts: overrides.alerts || {
      fire: async (payload) => { fireCalls.push(payload); },
    },
    isAgentEnabled: overrides.isAgentEnabled || (() => true),
    record: overrides.record || (async (payload) => { recordCalls.push(payload); return { _id: 'row1', ...payload }; }),
    now: overrides.now || (() => NOW),
    recordCalls,
    fireCalls,
  };
}

// ── flag off ─────────────────────────────────────────────────────────────────

test('runDaily: flag off short-circuits to zero DB reads and no ledger row', async () => {
  let touched = false;
  const deps = baseDeps({
    isAgentEnabled: () => false,
    LLMSpend: { aggregate: async () => { touched = true; return []; } },
    AgentDecision: { aggregate: async () => { touched = true; return []; } },
  });
  const result = await runDaily(deps);
  assert.deepStrictEqual(result, { findings: 0 });
  assert.strictEqual(touched, false);
  assert.strictEqual(deps.recordCalls.length, 0);
  assert.strictEqual(deps.fireCalls.length, 0);
});

// ── always-one-row ───────────────────────────────────────────────────────────

test('runDaily: always writes exactly one ledger row, even with zero findings', async () => {
  const deps = baseDeps();
  const result = await runDaily(deps);
  assert.deepStrictEqual(result, { findings: 0 });
  assert.strictEqual(deps.recordCalls.length, 1);
  const row = deps.recordCalls[0];
  assert.strictEqual(row.agentId, 'ops_sentinel');
  assert.strictEqual(row.decisionType, 'brief');
  assert.strictEqual(row.promptVersion, 'sentinel-v1');
  assert.strictEqual(row.action.kind, 'ops_brief');
  assert.deepStrictEqual(row.action.findings, []);
  assert.deepStrictEqual(row.action.reportCard, []);
  assert.deepStrictEqual(row.action.modelInventory, []);
  assert.strictEqual(deps.fireCalls.length, 0);
});

// ── zero-cost detector ───────────────────────────────────────────────────────

test('runDaily: zero-cost detector fires one finding per model with row counts', async () => {
  const deps = baseDeps({
    llmSpendFixture: {
      zeroCostRows: [
        { _id: 'claude-haiku-4-5', count: 3 },
        { _id: 'gemini-2.5-flash', count: 1 },
      ],
    },
  });
  const result = await runDaily(deps);
  assert.strictEqual(result.findings, 2);
  const row = deps.recordCalls[0];
  const zeroCostFindings = row.action.findings.filter((f) => f.kind === 'zero_cost');
  assert.strictEqual(zeroCostFindings.length, 2);
  assert.deepStrictEqual(
    zeroCostFindings.find((f) => f.model === 'claude-haiku-4-5'),
    { kind: 'zero_cost', model: 'claude-haiku-4-5', count: 3 },
  );
  assert.strictEqual(deps.fireCalls.length, 2);
  assert.ok(deps.fireCalls.some((c) => c.dedupKey === 'sentinel:zero_cost:claude-haiku-4-5'));
});

// ── spend-spike detector ─────────────────────────────────────────────────────

test('runDaily: spend-spike fires only above the factor AND the $1 floor, not at/below either boundary', async () => {
  const deps = baseDeps({
    llmSpendFixture: {
      spike24hRows: [
        { _id: 'task_spike', cost: 5 },                     // avg=1  -> factor=5   -> fires
        { _id: 'task_at_factor_boundary', cost: 4 },         // avg=2  -> factor=2   -> NOT > 2, no fire
        { _id: 'task_at_floor_boundary', cost: 1 },          // avg=0.1-> factor=10  -> cost not > $1 floor, no fire
        { _id: 'task_below_floor_high_factor', cost: 0.5 },  // avg=0.01->factor=50 -> cost < $1 floor, no fire
      ],
      spike30dRows: [
        { _id: 'task_spike', totalCost: 30 },
        { _id: 'task_at_factor_boundary', totalCost: 60 },
        { _id: 'task_at_floor_boundary', totalCost: 3 },
        { _id: 'task_below_floor_high_factor', totalCost: 0.3 },
      ],
    },
  });
  const result = await runDaily(deps);
  const spikeFindings = deps.recordCalls[0].action.findings.filter((f) => f.kind === 'spend_spike');
  assert.strictEqual(spikeFindings.length, 1);
  assert.strictEqual(spikeFindings[0].task_id, 'task_spike');
  assert.strictEqual(spikeFindings[0].cost24h, 5);
  assert.strictEqual(spikeFindings[0].dailyAvg30d, 1);
  assert.strictEqual(spikeFindings[0].factor, 5);
  assert.strictEqual(result.findings, 1);
});

test('runDaily: SENTINEL_SPEND_SPIKE_FACTOR env override raises/lowers the spike threshold', async () => {
  const deps = baseDeps({
    llmSpendFixture: {
      spike24hRows: [{ _id: 'task_spike', cost: 5 }], // factor=5 with avg=1
      spike30dRows: [{ _id: 'task_spike', totalCost: 30 }],
    },
  });
  const prev = process.env.SENTINEL_SPEND_SPIKE_FACTOR;
  process.env.SENTINEL_SPEND_SPIKE_FACTOR = '10';
  try {
    const result = await runDaily(deps);
    assert.strictEqual(result.findings, 0, 'factor=5 does not exceed an overridden threshold of 10');
  } finally {
    if (prev === undefined) delete process.env.SENTINEL_SPEND_SPIKE_FACTOR;
    else process.env.SENTINEL_SPEND_SPIKE_FACTOR = prev;
  }
});

// ── model inventory ──────────────────────────────────────────────────────────

test('runDaily: model inventory is informational-only — always on the ledger row, never a finding', async () => {
  const deps = baseDeps({
    llmSpendFixture: {
      modelRows: [{ _id: 'claude-sonnet-4-6' }, { _id: 'claude-haiku-4-5' }, { _id: null }],
    },
  });
  const result = await runDaily(deps);
  const row = deps.recordCalls[0];
  assert.deepStrictEqual(row.action.modelInventory, ['claude-haiku-4-5', 'claude-sonnet-4-6']);
  assert.strictEqual(row.action.findings.some((f) => f.kind === 'model_inventory' && !f.error), false);
  assert.strictEqual(result.findings, 0);
});

// ── agent report card ────────────────────────────────────────────────────────

test('runDaily: agent report card flags <30% acceptance or >50% ignored at >=10 responded rows, not at the boundaries', async () => {
  const reportRows = [
    { _id: { agentId: 'agentA', status: 'accepted' }, count: 3 },
    { _id: { agentId: 'agentA', status: 'rejected' }, count: 7 }, // responded=10, acceptance=0.30 exactly -> no finding
    { _id: { agentId: 'agentB', status: 'accepted' }, count: 2 },
    { _id: { agentId: 'agentB', status: 'rejected' }, count: 8 },
    { _id: { agentId: 'agentB', status: 'pending' }, count: 3 },  // responded=10, acceptance=0.20 -> finding
    { _id: { agentId: 'agentC', status: 'rejected' }, count: 9 }, // responded=9 -> below gate, no finding despite 0%
    { _id: { agentId: 'agentD', status: 'accepted' }, count: 5 },
    { _id: { agentId: 'agentD', status: 'ignored' }, count: 5 },  // responded=10, ignored=0.50 exactly -> no finding
    { _id: { agentId: 'agentE', status: 'accepted' }, count: 4 },
    { _id: { agentId: 'agentE', status: 'ignored' }, count: 6 },  // responded=10, ignored=0.60 -> finding
  ];
  const deps = baseDeps({ reportCardFixture: { reportRows } });
  const result = await runDaily(deps);
  const row = deps.recordCalls[0];

  assert.strictEqual(row.action.reportCard.length, 5, 'every agent gets a report-card row, findings or not');
  const findingAgents = row.action.findings.filter((f) => f.kind === 'agent_report_card').map((f) => f.agentId).sort();
  assert.deepStrictEqual(findingAgents, ['agentB', 'agentE']);
  assert.strictEqual(result.findings, 2);

  const agentBCard = row.action.reportCard.find((c) => c.agentId === 'agentB');
  assert.strictEqual(agentBCard.pendingBacklog, 3);
  assert.strictEqual(agentBCard.acceptance, 0.2);
});

// ── check isolation ──────────────────────────────────────────────────────────

test('runDaily: one check failing never blocks the other checks or the ledger row', async () => {
  const deps = baseDeps({
    LLMSpend: makeLLMSpend({
      throwOn: 'zero_cost',
      spike24hRows: [{ _id: 'task_spike', cost: 5 }],
      spike30dRows: [{ _id: 'task_spike', totalCost: 30 }],
      modelRows: [{ _id: 'claude-sonnet-4-6' }],
    }),
    reportCardFixture: {
      reportRows: [
        { _id: { agentId: 'agentB', status: 'accepted' }, count: 2 },
        { _id: { agentId: 'agentB', status: 'rejected' }, count: 8 },
      ],
    },
  });

  const result = await runDaily(deps);
  const row = deps.recordCalls[0];

  const zeroCostError = row.action.findings.find((f) => f.kind === 'zero_cost');
  assert.strictEqual(zeroCostError.error, true);
  assert.strictEqual(zeroCostError.message, 'zero-cost aggregate failed');

  const spikeFinding = row.action.findings.find((f) => f.kind === 'spend_spike');
  assert.ok(spikeFinding, 'spend-spike check still ran despite zero-cost failing');
  assert.strictEqual(spikeFinding.task_id, 'task_spike');

  assert.deepStrictEqual(row.action.modelInventory, ['claude-sonnet-4-6']);
  assert.strictEqual(row.action.reportCard.length, 1, 'report card still computed');

  assert.strictEqual(deps.recordCalls.length, 1, 'ledger row still written exactly once');
  assert.strictEqual(result.findings, row.action.findings.length);
});

// ── alerts.fire shape ────────────────────────────────────────────────────────

test('runDaily: fires alerts.fire once per finding with the documented category/dedupKey/severity shape', async () => {
  const deps = baseDeps({
    llmSpendFixture: {
      zeroCostRows: [{ _id: 'claude-haiku-4-5', count: 3 }],
    },
  });
  await runDaily(deps);
  assert.strictEqual(deps.fireCalls.length, 1);
  const call = deps.fireCalls[0];
  assert.strictEqual(call.category, 'agentic-sentinel');
  assert.strictEqual(typeof call.title, 'string');
  assert.strictEqual(call.dedupKey, 'sentinel:zero_cost:claude-haiku-4-5');
  assert.strictEqual(call.severity, 'warn');
  assert.deepStrictEqual(call.fields, { model: 'claude-haiku-4-5', count: 3 });
});
