'use strict';

const { test } = require('node:test');
const assert = require('assert');
const mongoose = require('mongoose');

const AgentDecision = require('./AgentDecision');

test('AgentDecision: valid pending proposal passes validateSync', () => {
  const doc = new AgentDecision({
    agentId: 'compass_actions',
    decisionType: 'proposal',
    userId: new mongoose.Types.ObjectId(),
    action: { title: 'Reshuffle this week', ops: [{ op: 'reset_skipped' }] },
    promptVersion: 'compass-v1',
    modelId: 'claude-sonnet-4-6',
  });
  assert.strictEqual(doc.validateSync(), undefined);
  assert.strictEqual(doc.status, 'pending');
});

test('AgentDecision: rejects unknown status and missing agentId', () => {
  const bad = new AgentDecision({
    decisionType: 'proposal',
    userId: new mongoose.Types.ObjectId(),
    action: {},
    status: 'maybe',
  });
  const err = bad.validateSync();
  assert.ok(err);
  assert.ok(err.errors.status);
  assert.ok(err.errors.agentId);
});

test('AgentDecision: decisionType is constrained', () => {
  const bad = new AgentDecision({
    agentId: 'compass_actions',
    decisionType: 'vibe',
    userId: new mongoose.Types.ObjectId(),
    action: {},
  });
  const err = bad.validateSync();
  assert.ok(err && err.errors.decisionType);
});
