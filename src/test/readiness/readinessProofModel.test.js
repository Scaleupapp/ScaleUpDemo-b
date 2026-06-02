'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const ReadinessProof = require('../../models/ReadinessProof');

test('ReadinessProof holds a token + frozen snapshot, defaults active', () => {
  const p = new ReadinessProof({
    token: 'abc123', userId: new mongoose.Types.ObjectId(), objectiveId: new mongoose.Types.ObjectId(),
    snapshot: { displayName: 'Aditya', objectiveLabel: 'Backend Engineer', score: 84, target: 80, band: 'Strong',
      competencies: [{ name: 'System Design', score: 88, assessed: true }],
      evidence: { assessments: 112, capstonesGraded: 8, coveragePct: 75, hoursInvested: 38 } },
  });
  assert.equal(p.active, true);
  assert.equal(p.viewCount, 0);
  assert.equal(p.snapshot.score, 84);
  assert.equal(p.snapshot.competencies[0].name, 'System Design');
});
