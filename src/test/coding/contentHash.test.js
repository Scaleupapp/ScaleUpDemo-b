'use strict';

/**
 * Unit tests for the contentHash helper.
 * Tests run without HTTP — pure function calls.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeContentHash, CANONICAL_FIELDS } =
  require('../../coding/services/contentHash');

const MINIMAL_BUNDLE = {
  brief: 'foo',
  role_track: 'swe',
  language: 'python',
  difficulty: 'easy',
  drill_subtype: 'prompt',
  reference_solution: { files: [] },
};

// ---------------------------------------------------------------------------
// Basic shape
// ---------------------------------------------------------------------------

test('computeContentHash: returns a 64-char hex string (sha256)', () => {
  const hash = computeContentHash(MINIMAL_BUNDLE);
  assert.match(hash, /^[0-9a-f]{64}$/, 'expected 64-char lowercase hex SHA-256');
});

test('computeContentHash: same input produces same hash (deterministic)', () => {
  const h1 = computeContentHash(MINIMAL_BUNDLE);
  const h2 = computeContentHash({ ...MINIMAL_BUNDLE });
  assert.strictEqual(h1, h2, 'hashes should be identical for identical input');
});

test('computeContentHash: different brief produces different hash', () => {
  const h1 = computeContentHash(MINIMAL_BUNDLE);
  const h2 = computeContentHash({ ...MINIMAL_BUNDLE, brief: 'bar' });
  assert.notStrictEqual(h1, h2, 'hashes should differ when brief differs');
});

// ---------------------------------------------------------------------------
// Canonical / stable
// ---------------------------------------------------------------------------

test('computeContentHash: object key order does not affect hash', () => {
  // Put fields in different order
  const bundleA = {
    brief: 'foo',
    role_track: 'swe',
    language: 'python',
    difficulty: 'easy',
    drill_subtype: 'prompt',
    reference_solution: { files: [] },
  };
  const bundleB = {
    difficulty: 'easy',
    reference_solution: { files: [] },
    drill_subtype: 'prompt',
    language: 'python',
    brief: 'foo',
    role_track: 'swe',
  };
  assert.strictEqual(
    computeContentHash(bundleA),
    computeContentHash(bundleB),
    'hash must be stable regardless of key order',
  );
});

test('computeContentHash: extra non-canonical field does NOT change the hash', () => {
  const h1 = computeContentHash(MINIMAL_BUNDLE);
  const h2 = computeContentHash({ ...MINIMAL_BUNDLE, time_budget_minutes: 10 });
  assert.strictEqual(h1, h2, 'non-canonical fields must not affect the hash');
});

// ---------------------------------------------------------------------------
// CANONICAL_FIELDS export
// ---------------------------------------------------------------------------

test('CANONICAL_FIELDS: exports an array of exactly 6 strings', () => {
  assert.ok(Array.isArray(CANONICAL_FIELDS), 'CANONICAL_FIELDS should be an array');
  assert.strictEqual(CANONICAL_FIELDS.length, 6, 'expected exactly 6 canonical fields');
  const expected = ['brief', 'role_track', 'language', 'difficulty', 'drill_subtype', 'reference_solution'];
  for (const f of expected) {
    assert.ok(CANONICAL_FIELDS.includes(f), `expected "${f}" in CANONICAL_FIELDS`);
  }
});
