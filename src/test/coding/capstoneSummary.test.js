'use strict';

/**
 * Unit tests for src/coding/services/capstoneSummary.js
 *
 * All Mongoose model calls + eligibility are stubbed — no DB. Covers the two
 * recent fixes:
 *   1. in_progress query excludes never-started sessions (phantom-in-progress).
 *   2. shapeMastery reads the flat `axes` (0-100) and rescales to 0-10 — it used
 *      to read a non-existent `.level` field, so every snapshot was {0,0,0,0}.
 */

require('dotenv').config();
process.env.OPENAI_API_KEY    = process.env.OPENAI_API_KEY    || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

// ── Stub eligibility BEFORE requiring the module under test (it destructures
//    evaluateCodingEligibility at load) so getRoleTrack returns 'swe'. ─────────
const eligibility = require('../../coding/services/codingEligibility');
eligibility.evaluateCodingEligibility = () => ({ eligible: true, role_track: 'swe' });

// ── Stub coding models ────────────────────────────────────────────────────────
const models = require('../../coding/models');
const UserObjective = require('../../models/UserObjective');

let capturedInProgressQuery = null;
let stubInProgress = null;
let stubMastery = null;

UserObjective.findOne = () => ({ lean: async () => ({ status: 'active', isPrimary: true }) });

models.CapstoneSession.findOne = (q) => {
  capturedInProgressQuery = q;
  return { lean: async () => stubInProgress };
};
models.CapstoneSession.find = () => ({
  sort: () => ({ limit: () => ({ populate: () => ({ lean: async () => [] }) }) }),
});
models.DifficultyState.findOne = () => ({ lean: async () => ({ current_difficulty: 'medium' }) });
models.MetaSkillMastery.findOne = () => ({ lean: async () => stubMastery });

const { buildSummary } = require('../../coding/services/capstoneSummary');

function reset() {
  capturedInProgressQuery = null;
  stubInProgress = null;
  stubMastery = null;
}

test('in_progress query excludes never-started sessions and requires started_at', async () => {
  reset();
  await buildSummary('user1');
  assert.ok(capturedInProgressQuery, 'in_progress query should have been issued');
  assert.deepStrictEqual(
    capturedInProgressQuery.status.$in,
    ['in_progress', 'paused', 'submitted', 'evaluating'],
    'provisioning/ready must NOT count as in_progress (phantom fix)'
  );
  assert.deepStrictEqual(capturedInProgressQuery.started_at, { $ne: null });
});

test('shapeMastery rescales flat axes (0-100) to the 0-10 summary scale', async () => {
  reset();
  stubMastery = { axes: { prompting: 80, verification: 60, decomposition: 40, refactoring: 20 } };
  const summary = await buildSummary('user1');
  assert.deepStrictEqual(summary.mastery, {
    prompting: 8,
    verification: 6,
    decomposition: 4,
    refactoring: 2,
  });
});

test('mastery is null when the user has no mastery doc (no crash)', async () => {
  reset();
  stubMastery = null;
  const summary = await buildSummary('user1');
  assert.strictEqual(summary.mastery, null);
});

test('summary_line nudges to laptop for an active session', async () => {
  reset();
  stubInProgress = { _id: 's1', bundle_id: 'b1', status: 'in_progress', started_at: new Date() };
  const summary = await buildSummary('user1');
  assert.match(summary.summary_line, /in progress/i);
  assert.strictEqual(summary.in_progress.status, 'in_progress');
});

test('summary_line says "being graded" for submitted/evaluating', async () => {
  reset();
  stubInProgress = { _id: 's1', bundle_id: 'b1', status: 'evaluating', started_at: new Date() };
  const summary = await buildSummary('user1');
  assert.match(summary.summary_line, /being graded/i);
});
