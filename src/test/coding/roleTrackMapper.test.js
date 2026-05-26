'use strict';

/**
 * Unit tests for roleTrackMapper helper.
 * Pure functions — no DB, no I/O.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mapObjectiveToRoleTrack,
  pickWeakestAxis,
  axisToSubtype,
  subtypeToAxis,
} = require('../../coding/services/roleTrackMapper');

// ---------------------------------------------------------------------------
// mapObjectiveToRoleTrack
// ---------------------------------------------------------------------------

test('mapObjectiveToRoleTrack: software_engineering → swe', () => {
  assert.strictEqual(mapObjectiveToRoleTrack('software_engineering'), 'swe');
});

test('mapObjectiveToRoleTrack: backend → swe', () => {
  assert.strictEqual(mapObjectiveToRoleTrack('backend'), 'swe');
});

test('mapObjectiveToRoleTrack: frontend → swe', () => {
  assert.strictEqual(mapObjectiveToRoleTrack('frontend'), 'swe');
});

test('mapObjectiveToRoleTrack: fullstack → swe', () => {
  assert.strictEqual(mapObjectiveToRoleTrack('fullstack'), 'swe');
});

test('mapObjectiveToRoleTrack: mobile_dev → swe', () => {
  assert.strictEqual(mapObjectiveToRoleTrack('mobile_dev'), 'swe');
});

test('mapObjectiveToRoleTrack: devops_sre → swe', () => {
  assert.strictEqual(mapObjectiveToRoleTrack('devops_sre'), 'swe');
});

test('mapObjectiveToRoleTrack: data_science → ds', () => {
  assert.strictEqual(mapObjectiveToRoleTrack('data_science'), 'ds');
});

test('mapObjectiveToRoleTrack: data_analyst → ds', () => {
  assert.strictEqual(mapObjectiveToRoleTrack('data_analyst'), 'ds');
});

test('mapObjectiveToRoleTrack: ml_engineer → ai_eng', () => {
  assert.strictEqual(mapObjectiveToRoleTrack('ml_engineer'), 'ai_eng');
});

test('mapObjectiveToRoleTrack: ai_engineer → ai_eng', () => {
  assert.strictEqual(mapObjectiveToRoleTrack('ai_engineer'), 'ai_eng');
});

test('mapObjectiveToRoleTrack: placement → null (unmapped)', () => {
  assert.strictEqual(mapObjectiveToRoleTrack('placement'), null);
});

test('mapObjectiveToRoleTrack: undefined → null', () => {
  assert.strictEqual(mapObjectiveToRoleTrack(undefined), null);
});

test('mapObjectiveToRoleTrack: null → null', () => {
  assert.strictEqual(mapObjectiveToRoleTrack(null), null);
});

test('mapObjectiveToRoleTrack: empty string → null', () => {
  assert.strictEqual(mapObjectiveToRoleTrack(''), null);
});

// Real canonical topic slugs also map correctly
test('mapObjectiveToRoleTrack: software-engineer (canonical slug) → swe', () => {
  assert.strictEqual(mapObjectiveToRoleTrack('software-engineer'), 'swe');
});

test('mapObjectiveToRoleTrack: data-scientist (canonical slug) → ds', () => {
  assert.strictEqual(mapObjectiveToRoleTrack('data-scientist'), 'ds');
});

test('mapObjectiveToRoleTrack: machine-learning-engineer (canonical slug) → ai_eng', () => {
  assert.strictEqual(mapObjectiveToRoleTrack('machine-learning-engineer'), 'ai_eng');
});

// ---------------------------------------------------------------------------
// pickWeakestAxis
// ---------------------------------------------------------------------------

test('pickWeakestAxis: null mastery → default to prompting', () => {
  assert.strictEqual(pickWeakestAxis(null), 'prompting');
});

test('pickWeakestAxis: no axes field → default to prompting', () => {
  assert.strictEqual(pickWeakestAxis({}), 'prompting');
});

test('pickWeakestAxis: returns the axis with the lowest value', () => {
  const mastery = {
    axes: { prompting: 80, verification: 30, decomposition: 90, refactoring: 70 },
  };
  assert.strictEqual(pickWeakestAxis(mastery), 'verification');
});

test('pickWeakestAxis: returns first minimum if tied (prompting is first)', () => {
  const mastery = {
    axes: { prompting: 50, verification: 50, decomposition: 50, refactoring: 50 },
  };
  assert.strictEqual(pickWeakestAxis(mastery), 'prompting');
});

test('pickWeakestAxis: single axis with zero value', () => {
  const mastery = {
    axes: { prompting: 0, verification: 100, decomposition: 100, refactoring: 100 },
  };
  assert.strictEqual(pickWeakestAxis(mastery), 'prompting');
});

// ---------------------------------------------------------------------------
// axisToSubtype
// ---------------------------------------------------------------------------

test('axisToSubtype: prompting → prompt', () => {
  assert.strictEqual(axisToSubtype('prompting'), 'prompt');
});

test('axisToSubtype: verification → verify', () => {
  assert.strictEqual(axisToSubtype('verification'), 'verify');
});

test('axisToSubtype: decomposition → decompose', () => {
  assert.strictEqual(axisToSubtype('decomposition'), 'decompose');
});

test('axisToSubtype: refactoring → refactor', () => {
  assert.strictEqual(axisToSubtype('refactoring'), 'refactor');
});

test('axisToSubtype: unknown → prompt (default)', () => {
  assert.strictEqual(axisToSubtype('unknown'), 'prompt');
});

// ---------------------------------------------------------------------------
// subtypeToAxis
// ---------------------------------------------------------------------------

test('subtypeToAxis: prompt → prompting', () => {
  assert.strictEqual(subtypeToAxis('prompt'), 'prompting');
});

test('subtypeToAxis: verify → verification', () => {
  assert.strictEqual(subtypeToAxis('verify'), 'verification');
});

test('subtypeToAxis: decompose → decomposition', () => {
  assert.strictEqual(subtypeToAxis('decompose'), 'decomposition');
});

test('subtypeToAxis: refactor → refactoring', () => {
  assert.strictEqual(subtypeToAxis('refactor'), 'refactoring');
});

test('subtypeToAxis: unknown → prompting (default)', () => {
  assert.strictEqual(subtypeToAxis('unknown'), 'prompting');
});
