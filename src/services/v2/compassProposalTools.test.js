'use strict';

const { test } = require('node:test');
const assert = require('assert');
const mongoose = require('mongoose');

const proposals = require('./compassProposalTools');

function fakeRecorder(rows) {
  return async (payload) => {
    rows.push(payload);
    return { _id: new mongoose.Types.ObjectId(), ...payload };
  };
}

test('PROPOSAL_TOOLS: exposes propose_plan_update with constrained ops', () => {
  const tool = proposals.PROPOSAL_TOOLS.find((t) => t.name === 'propose_plan_update');
  assert.ok(tool);
  const opSchema = tool.input_schema.properties.ops.items.properties.op;
  assert.deepStrictEqual(opSchema.enum.sort(), ['reset_skipped', 'set_task_status'].sort());
  assert.ok(proposals.isProposalTool('propose_plan_update'));
  assert.ok(!proposals.isProposalTool('explain_readiness'));
});

test('dispatch: records a pending decision and returns an agent_proposal card', async () => {
  const rows = [];
  const r = await proposals.dispatch(
    {
      userId: 'u1',
      name: 'propose_plan_update',
      input: {
        title: 'Protect exam week',
        summary: 'Move heavy work to Saturday',
        consequence: 'Readiness projection unchanged (Aug 12)',
        ops: [{ op: 'set_task_status', taskId: 't3', status: 'skipped' }],
      },
      meta: { promptVersion: 'compass-v1', modelId: 'claude-sonnet-4-6' },
    },
    { record: fakeRecorder(rows) }
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.card.type, 'agent_proposal');
  assert.ok(r.card.payload.decisionId);
  assert.strictEqual(r.card.payload.title, 'Protect exam week');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].agentId, 'compass_actions');
  assert.strictEqual(rows[0].decisionType, 'proposal');
  assert.strictEqual(rows[0].promptVersion, 'compass-v1');
  // The model's message must tell the user this is NOT applied yet.
  assert.match(r.output, /not applied|confirm/i);
});

test('dispatch: invalid ops never reach the ledger', async () => {
  const rows = [];
  const r = await proposals.dispatch(
    { userId: 'u1', name: 'propose_plan_update', input: { title: 'x', ops: [{ op: 'rm_rf' }] }, meta: {} },
    { record: fakeRecorder(rows) }
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(rows.length, 0);
  assert.strictEqual(r.card, null);
});

test('dispatch: title and non-empty ops are required', async () => {
  const rows = [];
  const r = await proposals.dispatch(
    { userId: 'u1', name: 'propose_plan_update', input: { ops: [] }, meta: {} },
    { record: fakeRecorder(rows) }
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(rows.length, 0);
});
