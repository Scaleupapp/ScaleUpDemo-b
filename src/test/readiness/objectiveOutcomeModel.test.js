'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const ObjectiveOutcome = require('../../models/ObjectiveOutcome');

test('ObjectiveOutcome holds label + frozen context', () => {
  const o = new ObjectiveOutcome({
    userId: new mongoose.Types.ObjectId(), objectiveId: new mongoose.Types.ObjectId(),
    objectiveType: 'interview_preparation', label: 'SUCCESS', rawChoice: 'got_role', source: 'i_got_it',
    context: { readinessAtCapture: 84, targetAtCapture: 80, bandAtCapture: 'Strong', readinessAtTarget: 82,
      peakReadiness: 86, wasEverReady: true, coverageAtCapture: 0.75, weeksToOutcome: 14 },
  });
  assert.equal(o.label, 'SUCCESS');
  assert.equal(o.resolved, true);
  assert.equal(o.context.peakReadiness, 86);
  assert.equal(o.allowTestimonialUse, false);
});
