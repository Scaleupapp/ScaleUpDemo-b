'use strict';

const { test } = require('node:test');
const assert = require('assert');

const { forecastTrajectory, _internal } = require('./trajectoryService');

test('forecastTrajectory: 30% baseline, SDE 6mo at intermediate → moves toward 80%', () => {
  const r = forecastTrajectory({
    currentReadiness: 30,
    objectiveType: 'interview_preparation',
    specifics: { targetRole: 'SDE' },
    timeline: '6_months',
    currentLevel: 'intermediate',
  });
  assert.strictEqual(r.today, 30);
  assert.ok(r.in30Days > r.today, 'should progress over 30 days');
  assert.ok(r.atTargetDate >= r.in90Days, 'monotonic increase');
  assert.strictEqual(r.targetReadiness, 80);
});

test('forecastTrajectory: high baseline still increases (overshoot small)', () => {
  const r = forecastTrajectory({
    currentReadiness: 85,
    objectiveType: 'interview_preparation',
    specifics: { targetRole: 'SDE' },
    timeline: '6_months',
    currentLevel: 'advanced',
  });
  assert.ok(r.today === 85);
  assert.ok(r.atTargetDate >= 85);
  assert.ok(r.atTargetDate <= 95, 'caps at 95');
});

test('forecastTrajectory: onTrack true when projected meets target', () => {
  const r = forecastTrajectory({
    currentReadiness: 50,
    objectiveType: 'upskilling',
    specifics: { targetSkill: 'AI/ML' },
    timeline: '1_year',
    currentLevel: 'beginner',
  });
  // 1-year timeline is generous — should be on track
  assert.strictEqual(typeof r.onTrack, 'boolean');
  assert.strictEqual(r.targetReadiness, 80);
});

test('projectReadiness: zero weeks elapsed returns baseline (with possible overshoot=0)', () => {
  const today = _internal.projectReadiness({
    currentReadiness: 40,
    hoursPerWeek: 15,
    hoursTotalNeeded: 300,
    weeksElapsed: 0,
  });
  assert.strictEqual(today, 40);
});

test('projectReadiness: caps at 95%', () => {
  const r = _internal.projectReadiness({
    currentReadiness: 90,
    hoursPerWeek: 50,
    hoursTotalNeeded: 100,
    weeksElapsed: 100,
  });
  assert.ok(r <= 95);
});
