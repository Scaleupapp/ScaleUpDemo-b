'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

test('assembleRows: resolved outcomes → {archetype,readiness,y}; PENDING/ABANDONED excluded; y mapping', async () => {
  const ObjectiveOutcome = require('../../models/ObjectiveOutcome');
  const svc = require('../../services/readiness/calibrationDataService');
  const docs = [
    { objectiveType: 'interview_preparation', label: 'SUCCESS', context: { readinessAtTarget: 82 } },
    { objectiveType: 'interview_preparation', label: 'NOT_SUCCESS', context: { readinessAtTarget: 60 } },
    { objectiveType: 'upskilling', label: 'PARTIAL', context: { readinessAtTarget: 70 } },
    { objectiveType: 'interview_preparation', label: 'PENDING', context: { readinessAtTarget: 50 } }, // excluded
    { objectiveType: 'interview_preparation', label: 'ABANDONED', context: { readinessAtTarget: 45 } }, // excluded
  ];
  const orig = ObjectiveOutcome.find;
  ObjectiveOutcome.find = () => ({ lean: async () => docs });
  try {
    const rows = await svc.assembleRows();
    assert.equal(rows.length, 3); // PENDING and ABANDONED excluded
    const iv = rows.find((r) => r.readiness === 82);
    assert.equal(iv.archetype, 'interview'); assert.equal(iv.y, 1);
    assert.equal(rows.find((r) => r.readiness === 60).y, 0);
    assert.equal(rows.find((r) => r.readiness === 70).y, 0.5); // PARTIAL
    const counts = await svc.countsByArchetype();
    assert.equal(counts.interview, 2);
  } finally { ObjectiveOutcome.find = orig; }
});
