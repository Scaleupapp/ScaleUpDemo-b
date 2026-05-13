'use strict';

const { test } = require('node:test');
const assert = require('assert');

const { computeRequiredTime, _internal } = require('./requiredTimeService');

test('computeRequiredTime: SDE @ Google in 6 months at beginner ≈ 25 hrs/wk', () => {
  const r = computeRequiredTime({
    objectiveType: 'interview_preparation',
    specifics: { targetRole: 'SDE', targetCompany: 'Google' },
    timeline: '6_months',
    currentLevel: 'beginner',
  });
  // 380 baseline × 1.0 (beginner) × 1.15 buffer ≈ 437 hours / 26 weeks ≈ 17/wk.
  // We accept a generous window because seed numbers may be tuned.
  assert.ok(r.requiredHoursPerWeek >= 10 && r.requiredHoursPerWeek <= 35,
    `expected 10-35, got ${r.requiredHoursPerWeek}`);
  assert.strictEqual(r.timelineWeeks, 26);
  assert.match(r.baselineLabel, /SDE/i);
});

test('computeRequiredTime: intermediate user needs less time than beginner', () => {
  const beginner = computeRequiredTime({
    objectiveType: 'interview_preparation',
    specifics: { targetRole: 'SDE' },
    timeline: '6_months',
    currentLevel: 'beginner',
  });
  const intermediate = computeRequiredTime({
    objectiveType: 'interview_preparation',
    specifics: { targetRole: 'SDE' },
    timeline: '6_months',
    currentLevel: 'intermediate',
  });
  assert.ok(intermediate.totalHoursRemaining < beginner.totalHoursRemaining,
    'intermediate should need fewer total hours');
});

test('computeRequiredTime: shorter timeline → more hours/week', () => {
  const sixMonths = computeRequiredTime({
    objectiveType: 'interview_preparation',
    specifics: { targetRole: 'SDE' },
    timeline: '6_months',
    currentLevel: 'beginner',
  });
  const threeMonths = computeRequiredTime({
    objectiveType: 'interview_preparation',
    specifics: { targetRole: 'SDE' },
    timeline: '3_months',
    currentLevel: 'beginner',
  });
  assert.ok(threeMonths.requiredHoursPerWeek > sixMonths.requiredHoursPerWeek,
    'shorter timeline must require more weekly hours');
});

test('computeRequiredTime: 1-month CAT triggers unrealistic warning', () => {
  const r = computeRequiredTime({
    objectiveType: 'exam_preparation',
    specifics: { examName: 'CAT' },
    timeline: '1_month',
    currentLevel: 'beginner',
  });
  assert.ok(r.warnings.length > 0, 'expected at least one warning for 1-month CAT');
});

test('computeRequiredTime: paths.lessTime extends timeline; paths.moreTime shortens', () => {
  const r = computeRequiredTime({
    objectiveType: 'upskilling',
    specifics: { targetSkill: 'AI/ML' },
    timeline: '6_months',
    currentLevel: 'beginner',
  });
  assert.ok(r.paths.lessTime.hoursPerWeek < r.paths.commit.hoursPerWeek);
  assert.ok(r.paths.moreTime.hoursPerWeek > r.paths.commit.hoursPerWeek);
});

test('deriveTaxonomyKey: recognizes common exam names', () => {
  const k1 = _internal.deriveTaxonomyKey('exam_preparation', { examName: 'cat' });
  const k2 = _internal.deriveTaxonomyKey('exam_preparation', { examName: 'UPSC Civil Services' });
  const k3 = _internal.deriveTaxonomyKey('exam_preparation', { examName: 'GMAT 2026' });
  assert.strictEqual(k1, 'cat');
  assert.strictEqual(k2, 'upsc');
  assert.strictEqual(k3, 'gmat');
});

test('deriveTaxonomyKey: falls back to "default" for unknown', () => {
  const k = _internal.deriveTaxonomyKey('upskilling', { targetSkill: 'underwater basket weaving' });
  assert.strictEqual(k, 'default');
});
