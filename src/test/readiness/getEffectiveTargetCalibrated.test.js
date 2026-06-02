'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('getEffectiveTarget: flag OFF -> heuristic unchanged; flag ON + cached model -> calibrated; flag ON + no model -> heuristic', () => {
  const cache = require('../../services/readiness/calibrationCache');
  const targetService = require('../../services/readiness/targetService');
  const obj = { objectiveType: 'interview_preparation', target: 82, specifics: {} };

  // flag controlled via the live featureFlags require — emulate by stubbing the flags module
  const flags = require('../../config/featureFlags');
  const origObjFlag = flags.objectiveTarget, origCalFlag = flags.outcomeCalibratedTarget;
  Object.defineProperty(flags, 'objectiveTarget', { value: true, configurable: true });

  try {
    // flag OFF -> persisted heuristic target (82)
    Object.defineProperty(flags, 'outcomeCalibratedTarget', { value: false, configurable: true });
    assert.equal(targetService.getEffectiveTarget(obj), 82);

    // flag ON + cached calibrated model (target 78, sufficient sampleCount) -> 78
    Object.defineProperty(flags, 'outcomeCalibratedTarget', { value: true, configurable: true });
    const { MIN_OUTCOMES_PER_ARCHETYPE } = require('../../services/readiness/calibrationService');
    cache._seed({ interview: { target: 78, sampleCount: MIN_OUTCOMES_PER_ARCHETYPE } });
    assert.equal(targetService.getEffectiveTarget(obj), 78);

    // flag ON + no model for this archetype -> heuristic (82)
    cache._seed({});
    assert.equal(targetService.getEffectiveTarget(obj), 82);
  } finally {
    Object.defineProperty(flags, 'objectiveTarget', { value: origObjFlag, configurable: true });
    Object.defineProperty(flags, 'outcomeCalibratedTarget', { value: origCalFlag, configurable: true });
  }
});
