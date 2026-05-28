#!/usr/bin/env node
'use strict';

/**
 * Backfill — one-time job that introduces existing learners to capstones
 * (spec §11). Mirrors the Phase A backfill-coding-meta-skills.js script
 * pattern: idempotent, batched, --dry-run flag mandatory on first run.
 *
 * Eligibility (spec §11.1):
 *   - primary_objective.category in the SWE / DS / AI-Eng cluster
 *   - last_active_at within the last 60 days
 *   - notification_preferences.product_updates = true
 *
 * Per-user actions (spec §11.2):
 *   1. Send a single invitation push: "New for you: Capstones — longer-
 *      form coding sessions on your laptop"
 *   2. NOTE: Mastery axes + readiness weighting were already wired by
 *      Phase A backfill (drills + capstones share the same axis space).
 *
 * What we explicitly DO NOT do (spec §11.3):
 *   - Auto-recompute Readiness Score visibly
 *   - Push more than once per user (idempotency table)
 *   - Backfill dormant users on re-activation
 *
 * Usage:
 *   node scripts/backfill-coding-capstones.js --dry-run         # required first
 *   node scripts/backfill-coding-capstones.js --execute          # actually push
 *   node scripts/backfill-coding-capstones.js --execute --limit 100
 *
 * Idempotency: each invite is recorded in the `notifications` collection
 * with type=`capstone_backfill_invite_v1`. Re-runs skip users who already
 * have that record.
 */

require('dotenv').config();
const mongoose = require('mongoose');

// Tiny arg parser — avoid pulling in minimist for one script.
const args = (() => {
  const out = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = process.argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
})();

const CHUNK_SIZE = 500;
const ELIGIBLE_OBJECTIVE_CATEGORIES = [
  'software_engineering',
  'backend',
  'frontend',
  'fullstack',
  'mobile_dev',
  'data_science',
  'data_analyst',
  'ml_engineer',
  'ai_engineer',
  'devops_sre',
];

async function main() {
  const dryRun = args['dry-run'] === true || !args.execute;
  const limit = args.limit ? Number(args.limit) : Infinity;

  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI required');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  const User = require('../src/models/User');
  const UserObjective = require('../src/models/UserObjective');
  const Notification = mongoose.models.Notification || require('../src/models/Notification');
  const notificationService = require('../src/services/notificationService');

  console.log(`Mode: ${dryRun ? 'DRY-RUN' : 'EXECUTE'}; limit=${isFinite(limit) ? limit : '∞'}`);

  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);

  const eligibleObjectives = await UserObjective.find({
    isPrimary: true,
    status: 'active',
    'specifics.category': { $in: ELIGIBLE_OBJECTIVE_CATEGORIES },
  })
    .select('userId')
    .lean();

  const eligibleUserIds = eligibleObjectives.map((o) => o.userId);

  const users = await User.find({
    _id: { $in: eligibleUserIds },
    last_active_at: { $gte: sixtyDaysAgo },
    'notification_preferences.product_updates': { $ne: false },
  })
    .select('_id')
    .lean();

  console.log(`Eligible users: ${users.length}`);

  let invited = 0;
  let skipped = 0;
  let errors = 0;
  const summary = { dryRun, processed: 0, invited: 0, skipped_already_invited: 0, errors: 0 };

  for (let i = 0; i < Math.min(users.length, limit); i += CHUNK_SIZE) {
    const chunk = users.slice(i, i + CHUNK_SIZE);
    for (const u of chunk) {
      summary.processed += 1;
      try {
        // Idempotency check
        const prior = await Notification.findOne({
          userId: u._id,
          type: 'capstone_backfill_invite_v1',
        }).select('_id').lean();

        if (prior) {
          skipped += 1;
          summary.skipped_already_invited += 1;
          continue;
        }

        if (dryRun) {
          invited += 1;
          summary.invited += 1;
          continue;
        }

        await notificationService.sendToUser(u._id, {
          title: 'New: Capstones',
          body: "Longer-form coding sessions on your laptop. Mobile shows progress, evaluator scores six dimensions.",
          data: { type: 'capstone_backfill_invite_v1' },
        });
        await Notification.create({
          userId: u._id,
          type: 'capstone_backfill_invite_v1',
          title: 'New: Capstones',
          message: 'Capstone Phase B invite (backfill)',
          createdAt: new Date(),
        }).catch(() => {});

        invited += 1;
        summary.invited += 1;
      } catch (err) {
        errors += 1;
        summary.errors += 1;
        console.warn(`[backfill] user=${u._id} error=${err.message}`);
      }
    }
    console.log(`Progress: processed=${summary.processed} invited=${invited} skipped=${skipped} errors=${errors}`);
  }

  console.log('\nSummary:', JSON.stringify(summary, null, 2));
  await mongoose.disconnect();
  process.exit(summary.errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
