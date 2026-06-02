'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Tests for calibrationService.evidenceFor.
 *
 * Stubs CalibrationModel.findOne and featureFlags via the same
 * direct property-replacement pattern used in outcomeRecord.test.js.
 * No real DB connection required.
 */

test('evidenceFor: returns null when outcomeCalibratedTarget flag is OFF', async () => {
  const CalibrationModel = require('../../models/CalibrationModel');
  const flags = require('../../config/featureFlags');
  const { evidenceFor } = require('../../services/readiness/calibrationService');

  const origFlag = flags.outcomeCalibratedTarget;
  const origFindOne = CalibrationModel.findOne;

  let called = false;
  CalibrationModel.findOne = () => { called = true; return { lean: async () => ({ archetype: 'interview', target: 78, sampleCount: 50, threshold: 0.7 }) }; };

  try {
    Object.defineProperty(flags, 'outcomeCalibratedTarget', { value: false, configurable: true });
    const result = await evidenceFor({ objectiveType: 'interview_preparation' });
    assert.equal(result, null, 'should be null when flag is off');
    assert.equal(called, false, 'findOne should not be called when flag is off');
  } finally {
    Object.defineProperty(flags, 'outcomeCalibratedTarget', { value: origFlag, configurable: true });
    CalibrationModel.findOne = origFindOne;
  }
});

test('evidenceFor: returns null when objective is falsy', async () => {
  const flags = require('../../config/featureFlags');
  const { evidenceFor } = require('../../services/readiness/calibrationService');

  const origFlag = flags.outcomeCalibratedTarget;
  try {
    Object.defineProperty(flags, 'outcomeCalibratedTarget', { value: true, configurable: true });
    assert.equal(await evidenceFor(null), null);
    assert.equal(await evidenceFor(undefined), null);
  } finally {
    Object.defineProperty(flags, 'outcomeCalibratedTarget', { value: origFlag, configurable: true });
  }
});

test('evidenceFor: returns null when sampleCount is below 25 (MIN_OUTCOMES_PER_ARCHETYPE)', async () => {
  const CalibrationModel = require('../../models/CalibrationModel');
  const flags = require('../../config/featureFlags');
  const { evidenceFor } = require('../../services/readiness/calibrationService');

  const origFlag = flags.outcomeCalibratedTarget;
  const origFindOne = CalibrationModel.findOne;

  CalibrationModel.findOne = () => ({ lean: async () => ({ archetype: 'interview', target: 78, sampleCount: 24, threshold: 0.7, computedAt: new Date() }) });

  try {
    Object.defineProperty(flags, 'outcomeCalibratedTarget', { value: true, configurable: true });
    const result = await evidenceFor({ objectiveType: 'interview_preparation' });
    assert.equal(result, null, 'should be null when sampleCount < 25');
  } finally {
    Object.defineProperty(flags, 'outcomeCalibratedTarget', { value: origFlag, configurable: true });
    CalibrationModel.findOne = origFindOne;
  }
});

test('evidenceFor: returns null when model has no target (typeof target !== number)', async () => {
  const CalibrationModel = require('../../models/CalibrationModel');
  const flags = require('../../config/featureFlags');
  const { evidenceFor } = require('../../services/readiness/calibrationService');

  const origFlag = flags.outcomeCalibratedTarget;
  const origFindOne = CalibrationModel.findOne;

  CalibrationModel.findOne = () => ({ lean: async () => ({ archetype: 'interview', target: null, sampleCount: 50, threshold: 0.7 }) });

  try {
    Object.defineProperty(flags, 'outcomeCalibratedTarget', { value: true, configurable: true });
    const result = await evidenceFor({ objectiveType: 'interview_preparation' });
    assert.equal(result, null, 'should be null when target is not a number');
  } finally {
    Object.defineProperty(flags, 'outcomeCalibratedTarget', { value: origFlag, configurable: true });
    CalibrationModel.findOne = origFindOne;
  }
});

test('evidenceFor: returns null when no model found in DB', async () => {
  const CalibrationModel = require('../../models/CalibrationModel');
  const flags = require('../../config/featureFlags');
  const { evidenceFor } = require('../../services/readiness/calibrationService');

  const origFlag = flags.outcomeCalibratedTarget;
  const origFindOne = CalibrationModel.findOne;

  CalibrationModel.findOne = () => ({ lean: async () => null });

  try {
    Object.defineProperty(flags, 'outcomeCalibratedTarget', { value: true, configurable: true });
    const result = await evidenceFor({ objectiveType: 'interview_preparation' });
    assert.equal(result, null, 'should be null when DB returns null');
  } finally {
    Object.defineProperty(flags, 'outcomeCalibratedTarget', { value: origFlag, configurable: true });
    CalibrationModel.findOne = origFindOne;
  }
});

test('evidenceFor: returns populated evidence object when sampleCount >= 25', async () => {
  const CalibrationModel = require('../../models/CalibrationModel');
  const flags = require('../../config/featureFlags');
  const { evidenceFor } = require('../../services/readiness/calibrationService');

  const origFlag = flags.outcomeCalibratedTarget;
  const origFindOne = CalibrationModel.findOne;

  const computedAt = new Date('2026-05-01T00:00:00Z');
  CalibrationModel.findOne = () => ({
    lean: async () => ({ archetype: 'interview', target: 78, sampleCount: 42, threshold: 0.7, computedAt }),
  });

  try {
    Object.defineProperty(flags, 'outcomeCalibratedTarget', { value: true, configurable: true });
    const result = await evidenceFor({ objectiveType: 'interview_preparation' });
    assert.ok(result !== null, 'should return evidence object');
    assert.equal(result.basedOnOutcomes, 42);
    assert.equal(result.archetype, 'interview');
    assert.equal(result.archetypeLabel, 'interview goals');
    assert.equal(result.successRate, 0.7);
    assert.equal(result.target, 78);
    assert.deepEqual(result.computedAt, computedAt);
  } finally {
    Object.defineProperty(flags, 'outcomeCalibratedTarget', { value: origFlag, configurable: true });
    CalibrationModel.findOne = origFindOne;
  }
});

test('evidenceFor: archetypeLabel mapping — all four archetypes', async () => {
  const CalibrationModel = require('../../models/CalibrationModel');
  const flags = require('../../config/featureFlags');
  const { evidenceFor } = require('../../services/readiness/calibrationService');

  const origFlag = flags.outcomeCalibratedTarget;
  const origFindOne = CalibrationModel.findOne;

  Object.defineProperty(flags, 'outcomeCalibratedTarget', { value: true, configurable: true });

  const cases = [
    // [objectiveType, expectedArchetype, expectedLabel]
    ['interview_preparation', 'interview', 'interview goals'],
    ['career_switch', 'interview', 'interview goals'],
    ['exam_preparation', 'exam', 'exam goals'],
    ['upskilling', 'skill', 'skill-building goals'],
    ['academic_excellence', 'skill', 'skill-building goals'],
    ['casual_learning', 'generic', 'goals'],
  ];

  try {
    for (const [objectiveType, expectedArchetype, expectedLabel] of cases) {
      CalibrationModel.findOne = (query) => ({
        lean: async () => ({ archetype: query.archetype, target: 78, sampleCount: 30, threshold: 0.7, computedAt: null }),
      });
      const result = await evidenceFor({ objectiveType });
      assert.ok(result !== null, `expected evidence for ${objectiveType}`);
      assert.equal(result.archetype, expectedArchetype, `archetype mismatch for ${objectiveType}`);
      assert.equal(result.archetypeLabel, expectedLabel, `archetypeLabel mismatch for ${objectiveType}`);
    }
  } finally {
    Object.defineProperty(flags, 'outcomeCalibratedTarget', { value: origFlag, configurable: true });
    CalibrationModel.findOne = origFindOne;
  }
});

test('evidenceFor: exact boundary — sampleCount=25 (the threshold) should pass', async () => {
  const CalibrationModel = require('../../models/CalibrationModel');
  const flags = require('../../config/featureFlags');
  const { evidenceFor } = require('../../services/readiness/calibrationService');

  const origFlag = flags.outcomeCalibratedTarget;
  const origFindOne = CalibrationModel.findOne;

  CalibrationModel.findOne = () => ({ lean: async () => ({ archetype: 'exam', target: 85, sampleCount: 25, threshold: 0.7, computedAt: null }) });

  try {
    Object.defineProperty(flags, 'outcomeCalibratedTarget', { value: true, configurable: true });
    const result = await evidenceFor({ objectiveType: 'exam_preparation' });
    assert.ok(result !== null, 'sampleCount=25 is exactly at threshold, should pass');
    assert.equal(result.basedOnOutcomes, 25);
    assert.equal(result.archetypeLabel, 'exam goals');
  } finally {
    Object.defineProperty(flags, 'outcomeCalibratedTarget', { value: origFlag, configurable: true });
    CalibrationModel.findOne = origFindOne;
  }
});
