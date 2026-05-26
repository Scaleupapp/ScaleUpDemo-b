#!/usr/bin/env node
/**
 * One-time migration: identify existing users whose primary objective maps to a
 * coding role-track and prepare them for the coding-practice feature.
 *
 *   1. Silently create an empty MetaSkillMastery doc (all axes 0, confidence 0)
 *   2. Send ONE invitation push notification (coding_calibration_invitation)
 *   3. Idempotent — re-runs skip users who already have a mastery doc;
 *      duplicate pushes are also prevented
 *
 * Usage:
 *   node scripts/backfill-coding-meta-skills.js [--dry-run] [--batch-size=N]
 *
 * Environment:
 *   MONGODB_URI  — required when run as a standalone script
 */

'use strict';

require('dotenv').config();

const mongoose = require('mongoose');

const { MetaSkillMastery } = require('../src/coding/models');
const { mapObjectiveToRoleTrack } = require('../src/coding/services/roleTrackMapper');
const { NOTIFICATION_TYPES, buildPayload } = require('../src/coding/services/codingNotifications');

// Discover app models — try/catch so the module can still be unit-tested with stubs
let User, UserObjective, Notification;
try { User         = require('../src/models/User'); }         catch (e) { /* not found */ }
try { UserObjective = require('../src/models/UserObjective'); } catch (e) { /* not found */ }
try { Notification  = require('../src/models/Notification'); }  catch (e) { /* not found */ }

/** Stamp placed on every MetaSkillMastery doc created by this backfill */
const BACKFILL_BATCH_TAG = 'coding-meta-skills-v1';

// ─────────────────────────────────────────────────────────────────────────────
// Eligibility
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return an array of { userId, role_track } for users eligible to be backfilled.
 *
 * Eligibility criteria:
 *   - Active primary UserObjective whose canonicalTopic maps to a role_track
 *   - User was active within `since` window (lastLoginAt >= since)
 *   - User has not opted out of product-update notifications
 *
 * @param {{ since: Date, limit: number }} opts
 * @returns {Promise<Array<{ userId: string, role_track: string }>>}
 */
async function findEligibleUsers({ since, limit }) {
  if (!UserObjective || !User) throw new Error('User / UserObjective models not found');

  // Over-fetch objectives to account for post-filter drop-off
  const objectives = await UserObjective.find({
    status:    'active',
    isPrimary: true,
  }).limit(limit * 5).lean();

  const candidates = [];

  for (const obj of objectives) {
    const roleTrack = mapObjectiveToRoleTrack(obj.canonicalTopic);
    if (!roleTrack) continue;

    const user = await User.findById(obj.userId).select('lastLoginAt notificationPreferences').lean();
    if (!user) continue;

    // Must have been active within the window
    if (!user.lastLoginAt || new Date(user.lastLoginAt) < since) continue;

    // Honour notification opt-out if the field exists
    if (user.notificationPreferences && user.notificationPreferences.productUpdates === false) continue;

    candidates.push({ userId: obj.userId, role_track: roleTrack });
    if (candidates.length >= limit) break;
  }

  return candidates;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-user backfill
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Backfill a single user.  Idempotent: skips if mastery already exists.
 *
 * @param {{ userId, role_track, dryRun: boolean, logger: object }} opts
 * @returns {Promise<{ action: 'skipped'|'dry_run'|'backfilled', userId, role_track, pushed?: boolean }>}
 */
async function backfillUser({ userId, role_track, dryRun, logger }) {
  // Idempotency check — skip if mastery already exists
  const existing = await MetaSkillMastery.findOne({ user_id: userId, role_track });
  if (existing) {
    logger.log(`[skip] user=${userId} role_track=${role_track} (mastery exists)`);
    return { action: 'skipped', userId, role_track };
  }

  if (dryRun) {
    logger.log(`[dry-run] would backfill user=${userId} role_track=${role_track}`);
    return { action: 'dry_run', userId, role_track };
  }

  // Create empty mastery document
  await MetaSkillMastery.create({
    user_id:       userId,
    role_track,
    axes: {
      prompting:     0,
      verification:  0,
      decomposition: 0,
      refactoring:   0,
    },
    confidence:    0,
    attempt_count: 0,
  });

  // Idempotent push — only send if no calibration-invitation record exists
  let pushed = false;
  if (Notification) {
    const existingPush = await Notification.findOne({
      userId,
      type: NOTIFICATION_TYPES.CODING_CALIBRATION_INVITATION,
    });

    if (!existingPush) {
      const payload = buildPayload(NOTIFICATION_TYPES.CODING_CALIBRATION_INVITATION);
      await Notification.create({
        userId,
        type:    payload.type,
        title:   payload.title,
        message: payload.body,   // Notification schema uses `message`, not `body`
        data:    { ...payload.data, role_track, backfill_batch: BACKFILL_BATCH_TAG },
        status:  'pending',
      });
      pushed = true;
    }
  }

  logger.log(`[ok] user=${userId} role_track=${role_track} pushed=${pushed}`);
  return { action: 'backfilled', userId, role_track, pushed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the full backfill.
 *
 * @param {{ dryRun?: boolean, batchSize?: number, since?: Date|null, logger?: object }} opts
 * @returns {Promise<{ eligible: number, backfilled: number, skipped: number, pushed: number, errors: Array }>}
 */
async function runBackfill({ dryRun = false, batchSize = 500, since = null, logger = console } = {}) {
  const sinceDate = since || new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  const summary   = { eligible: 0, backfilled: 0, skipped: 0, pushed: 0, errors: [] };

  const candidates = await findEligibleUsers({ since: sinceDate, limit: batchSize });
  summary.eligible = candidates.length;

  for (const candidate of candidates) {
    try {
      const result = await backfillUser({ ...candidate, dryRun, logger });
      if (result.action === 'backfilled') summary.backfilled++;
      else if (result.action === 'skipped') summary.skipped++;
      if (result.pushed) summary.pushed++;
    } catch (err) {
      summary.errors.push({ userId: candidate.userId.toString(), error: err.message });
    }
  }

  return summary;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI entry point
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const args      = process.argv.slice(2);
  const dryRun    = args.includes('--dry-run');
  const batchArg  = args.find(a => a.startsWith('--batch-size='));
  const batchSize = batchArg ? parseInt(batchArg.split('=')[1], 10) : 500;

  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  try {
    const summary = await runBackfill({ dryRun, batchSize });
    console.log('\n=== Coding meta-skills backfill summary ===');
    console.log(JSON.stringify(summary, null, 2));
    if (summary.errors.length > 0) process.exit(2);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}

module.exports = { runBackfill, backfillUser, findEligibleUsers, BACKFILL_BATCH_TAG };
