'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assessmentTypesToPrimitive } = require('../../services/readiness/primitiveMap');

test('knowledge/exam types -> quiz', () => {
  assert.strictEqual(assessmentTypesToPrimitive(['knowledge_recall'], { coding: false }), 'quiz');
  assert.strictEqual(assessmentTypesToPrimitive(['exam_style'], { coding: false }), 'quiz');
});
test('applied/framework -> coding when coding-eligible, else interview', () => {
  assert.strictEqual(assessmentTypesToPrimitive(['applied_scenario'], { coding: true }), 'coding');
  assert.strictEqual(assessmentTypesToPrimitive(['framework_application'], { coding: false }), 'interview');
});
test('situational/case -> interview', () => {
  assert.strictEqual(assessmentTypesToPrimitive(['situational_judgment'], { coding: true }), 'interview');
  assert.strictEqual(assessmentTypesToPrimitive(['case_study'], { coding: false }), 'interview');
});
test('empty/unknown -> quiz (safe default)', () => {
  assert.strictEqual(assessmentTypesToPrimitive([], { coding: false }), 'quiz');
  assert.strictEqual(assessmentTypesToPrimitive(['nonsense'], { coding: true }), 'quiz');
});
test('mixed types pick the highest-signal primitive (interview > coding > quiz)', () => {
  assert.strictEqual(assessmentTypesToPrimitive(['knowledge_recall', 'case_study'], { coding: true }), 'interview');
  assert.strictEqual(assessmentTypesToPrimitive(['knowledge_recall', 'applied_scenario'], { coding: true }), 'coding');
});
