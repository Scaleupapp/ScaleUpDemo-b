'use strict';

/**
 * Unit tests for drill Joi validators.
 * Tests run without HTTP — pure function calls against the validators.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// Validators live at src/coding/validators/drill.validator.js
const { validateDrillSubmission, validateDrillStart } =
  require('../../coding/validators/drill.validator');

// ---------------------------------------------------------------------------
// validateDrillSubmission
// ---------------------------------------------------------------------------

test('validateDrillSubmission: empty object returns error', () => {
  const { error } = validateDrillSubmission({});
  assert.ok(error, 'expected an error for empty payload');
});

test('validateDrillSubmission: accepts valid prompt drill', () => {
  const { error, value } = validateDrillSubmission({
    drill_subtype: 'prompt',
    submission: { prompt_text: 'Write a function that reverses a string' },
  });
  assert.strictEqual(error, undefined, `unexpected error: ${error && error.message}`);
  assert.ok(value);
});

test('validateDrillSubmission: accepts valid verify drill with bug_locations', () => {
  const { error } = validateDrillSubmission({
    drill_subtype: 'verify',
    submission: {
      bug_locations: [
        { file: 'main.js', line: 42, explanation: 'Off-by-one error in loop' },
      ],
    },
  });
  assert.strictEqual(error, undefined, `unexpected error: ${error && error.message}`);
});

test('validateDrillSubmission: rejects verify submission without bug_locations', () => {
  const { error } = validateDrillSubmission({
    drill_subtype: 'verify',
    submission: {},
  });
  assert.ok(error, 'expected an error when bug_locations is missing');
});

test('validateDrillSubmission: accepts decompose with 3 steps', () => {
  const { error } = validateDrillSubmission({
    drill_subtype: 'decompose',
    submission: {
      decomposition_steps: [
        { step: 'Parse input', rationale: 'Must read before processing' },
        { step: 'Validate data', rationale: 'Prevent invalid state' },
        { step: 'Output result', rationale: 'Return to caller' },
      ],
    },
  });
  assert.strictEqual(error, undefined, `unexpected error: ${error && error.message}`);
});

test('validateDrillSubmission: rejects decompose with only 1 step (min 2 required)', () => {
  const { error } = validateDrillSubmission({
    drill_subtype: 'decompose',
    submission: {
      decomposition_steps: [
        { step: 'Only step', rationale: 'Not enough' },
      ],
    },
  });
  assert.ok(error, 'expected an error when fewer than 2 decomposition steps');
});

test('validateDrillSubmission: accepts refactor with refactored_code.files (min 1)', () => {
  const { error } = validateDrillSubmission({
    drill_subtype: 'refactor',
    submission: {
      refactored_code: {
        files: [{ path: 'src/utils.js', content: 'export function foo() {}' }],
      },
    },
  });
  assert.strictEqual(error, undefined, `unexpected error: ${error && error.message}`);
});

// ---------------------------------------------------------------------------
// validateDrillStart
// ---------------------------------------------------------------------------

test('validateDrillStart: empty object returns error', () => {
  const { error } = validateDrillStart({});
  assert.ok(error, 'expected an error for empty payload');
});

test('validateDrillStart: accepts valid start payload', () => {
  const { error, value } = validateDrillStart({
    role_track: 'swe',
    difficulty: 'easy',
    drill_subtype: 'prompt',
  });
  assert.strictEqual(error, undefined, `unexpected error: ${error && error.message}`);
  assert.ok(value);
});
