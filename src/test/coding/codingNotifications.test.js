'use strict';

/**
 * Unit tests for src/coding/services/codingNotifications.js
 *
 * Pure module — no DB or network connections required.
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const {
  NOTIFICATION_TYPES,
  TEMPLATES,
  buildPayload,
} = require('../../coding/services/codingNotifications');

// ── 1. buildPayload for coding_drill_ready ────────────────────────────────────

test('buildPayload("coding_drill_ready") returns correct title, body and data.category', () => {
  const payload = buildPayload(NOTIFICATION_TYPES.CODING_DRILL_READY);
  assert.ok(typeof payload.title === 'string' && payload.title.length > 0, 'title should be non-empty string');
  assert.ok(typeof payload.body === 'string' && payload.body.length > 0, 'body should be non-empty string');
  assert.strictEqual(payload.type, 'coding_drill_ready');
  assert.strictEqual(payload.data.category, 'coding');
});

// ── 2. buildPayload passes extra data fields through ─────────────────────────

test('buildPayload("coding_drill_ready", { bundle_id: "abc" }) includes bundle_id in data', () => {
  const payload = buildPayload(NOTIFICATION_TYPES.CODING_DRILL_READY, { bundle_id: 'abc' });
  assert.strictEqual(payload.data.bundle_id, 'abc');
  assert.strictEqual(payload.data.category, 'coding');
});

// ── 3. buildPayload for unknown type → throws ─────────────────────────────────

test('buildPayload("unknown_type") throws with message referencing the type', () => {
  assert.throws(
    () => buildPayload('unknown_type'),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('unknown_type'), `message: ${err.message}`);
      return true;
    },
  );
});

// ── 4. NOTIFICATION_TYPES constant values ────────────────────────────────────

test('NOTIFICATION_TYPES.CODING_CALIBRATION_INVITATION === "coding_calibration_invitation"', () => {
  assert.strictEqual(
    NOTIFICATION_TYPES.CODING_CALIBRATION_INVITATION,
    'coding_calibration_invitation',
  );
});

test('NOTIFICATION_TYPES.CODING_DRILL_READY === "coding_drill_ready"', () => {
  assert.strictEqual(NOTIFICATION_TYPES.CODING_DRILL_READY, 'coding_drill_ready');
});

test('NOTIFICATION_TYPES.CODING_DIFFICULTY_CHANGE_SUGGESTION === "coding_difficulty_change_suggestion"', () => {
  assert.strictEqual(
    NOTIFICATION_TYPES.CODING_DIFFICULTY_CHANGE_SUGGESTION,
    'coding_difficulty_change_suggestion',
  );
});

// ── 5. All 3 templates have non-empty title and body ─────────────────────────

test('all 3 coding notification templates have a non-empty title and body', () => {
  const expectedTypes = [
    NOTIFICATION_TYPES.CODING_DRILL_READY,
    NOTIFICATION_TYPES.CODING_CALIBRATION_INVITATION,
    NOTIFICATION_TYPES.CODING_DIFFICULTY_CHANGE_SUGGESTION,
  ];

  for (const type of expectedTypes) {
    const tpl = TEMPLATES[type];
    assert.ok(tpl, `TEMPLATES["${type}"] should exist`);
    assert.ok(
      typeof tpl.title === 'string' && tpl.title.length > 0,
      `TEMPLATES["${type}"].title should be non-empty`,
    );
    assert.ok(
      typeof tpl.body === 'string' && tpl.body.length > 0,
      `TEMPLATES["${type}"].body should be non-empty`,
    );
  }
});

// ── 6. buildPayload for calibration_invitation ───────────────────────────────

test('buildPayload("coding_calibration_invitation") has correct type and category', () => {
  const payload = buildPayload(NOTIFICATION_TYPES.CODING_CALIBRATION_INVITATION);
  assert.strictEqual(payload.type, 'coding_calibration_invitation');
  assert.strictEqual(payload.data.category, 'coding');
});

// ── 7. buildPayload for difficulty_change_suggestion ─────────────────────────

test('buildPayload("coding_difficulty_change_suggestion") has correct type and category', () => {
  const payload = buildPayload(NOTIFICATION_TYPES.CODING_DIFFICULTY_CHANGE_SUGGESTION, { role_track: 'swe' });
  assert.strictEqual(payload.type, 'coding_difficulty_change_suggestion');
  assert.strictEqual(payload.data.category, 'coding');
  assert.strictEqual(payload.data.role_track, 'swe');
});
