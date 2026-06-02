'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

test('buildContext freezes latest/peak/nearest-target readiness from snapshot history', async () => {
  const ReadinessSnapshot = require('../../models/ReadinessSnapshot');
  const outcomeService = require('../../services/readiness/outcomeService');
  const objId = new mongoose.Types.ObjectId();
  const target = new Date('2026-06-01');
  const snaps = [
    { value: 70, createdAt: new Date('2026-04-01'), shadow: { coverage: 0.6 } },
    { value: 86, createdAt: new Date('2026-05-20'), shadow: { coverage: 0.74 } }, // peak
    { value: 82, createdAt: new Date('2026-06-02'), shadow: { coverage: 0.75 } }, // latest + nearest target
  ];
  const orig = ReadinessSnapshot.find;
  ReadinessSnapshot.find = () => ({ sort: () => ({ lean: async () => [...snaps].reverse() } ) }); // newest-first
  try {
    const objective = { _id: objId, userId: new mongoose.Types.ObjectId(), objectiveType: 'upskilling',
      target: 80, targetDate: target, readyState: { isReady: true }, createdAt: new Date('2026-02-22') };
    const ctx = await outcomeService.buildContext(objective);
    assert.equal(ctx.readinessAtCapture, 82); // latest
    assert.equal(ctx.peakReadiness, 86);
    assert.equal(ctx.readinessAtTarget, 82); // nearest 2026-06-02 to target 2026-06-01
    assert.equal(ctx.wasEverReady, true);
    assert.equal(ctx.targetAtCapture, 80);
    assert.ok(ctx.weeksToOutcome >= 1);
  } finally { ReadinessSnapshot.find = orig; }
});
