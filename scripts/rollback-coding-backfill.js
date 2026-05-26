#!/usr/bin/env node
/**
 * Rollback script for scripts/backfill-coding-meta-skills.js
 *
 * Reverses the effects of the coding meta-skills backfill by:
 *   1. Deleting MetaSkillMastery rows that are still in their initial backfill
 *      state (all axes 0, attempt_count 0 — any real attempt moves at least one axis).
 *   2. Deleting DifficultyState rows that are still in their initial state
 *      (current_difficulty 'easy', recommendation_history empty).
 *   3. Marking Notification rows created by the backfill as rolled_back
 *      (sets data.backfill_rolled_back: true). Does NOT delete — notifications
 *      may have already been delivered to devices.
 *
 * Usage:
 *   node scripts/rollback-coding-backfill.js [--dry-run]
 *
 * Environment:
 *   MONGODB_URI  — required when run as a standalone script
 */

'use strict';

require('dotenv').config();
const mongoose = require('mongoose');

const { MetaSkillMastery, DifficultyState } = require('../src/coding/models');

// Optional — rollback marks notifications but does not require Notification to be present
let Notification;
try { Notification = require('../src/models/Notification'); } catch (e) { /* not found */ }

/** Matches the tag stamped on backfill notifications — re-exported from the backfill script */
const BACKFILL_BATCH_TAG = 'coding-meta-skills-v1';

// ─────────────────────────────────────────────────────────────────────────────
// Identification helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true when a MetaSkillMastery doc is unambiguously backfill-created:
 * all four axes at 0 AND attempt_count 0.  Any real user attempt would have
 * updated at least one axis, so these rows have never been used.
 */
function isUntouchedMastery(doc) {
  if (!doc || !doc.axes) return false;
  return (
    doc.attempt_count === 0 &&
    doc.axes.prompting     === 0 &&
    doc.axes.verification  === 0 &&
    doc.axes.decomposition === 0 &&
    doc.axes.refactoring   === 0
  );
}

/**
 * Returns true when a DifficultyState doc is unambiguously backfill-created:
 * difficulty 'easy' (the backfill default) AND no recommendation history.
 */
function isUntouchedDifficulty(doc) {
  if (!doc) return false;
  return (
    doc.current_difficulty === 'easy' &&
    (!doc.recommendation_history || doc.recommendation_history.length === 0)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Finders
// ─────────────────────────────────────────────────────────────────────────────

async function findMasteryToDelete() {
  return MetaSkillMastery.find({
    attempt_count:         0,
    'axes.prompting':      0,
    'axes.verification':   0,
    'axes.decomposition':  0,
    'axes.refactoring':    0,
  }).lean();
}

async function findDifficultyToDelete() {
  return DifficultyState.find({
    current_difficulty:   'easy',
    recommendation_history: { $size: 0 },
  }).lean();
}

async function findNotificationsToMark() {
  if (!Notification) return [];
  return Notification.find({ 'data.backfill_batch': BACKFILL_BATCH_TAG }).lean();
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the rollback.
 *
 * @param {{ dryRun?: boolean, logger?: object }} opts
 * @returns {Promise<{
 *   mastery_to_delete:      number,
 *   mastery_deleted:        number,
 *   difficulty_to_delete:   number,
 *   difficulty_deleted:     number,
 *   notifications_to_mark:  number,
 *   notifications_marked:   number,
 *   errors: Array,
 * }>}
 */
async function runRollback({ dryRun = false, logger = console } = {}) {
  const summary = {
    mastery_to_delete:     0,
    mastery_deleted:       0,
    difficulty_to_delete:  0,
    difficulty_deleted:    0,
    notifications_to_mark: 0,
    notifications_marked:  0,
    errors: [],
  };

  // ── 1. MetaSkillMastery ────────────────────────────────────────────────────
  const masteryDocs = await findMasteryToDelete();
  summary.mastery_to_delete = masteryDocs.length;

  for (const doc of masteryDocs) {
    if (dryRun) {
      logger.log(
        `[dry-run] would delete MetaSkillMastery ${doc._id}` +
        ` (user=${doc.user_id} role_track=${doc.role_track})`
      );
    } else {
      try {
        await MetaSkillMastery.deleteOne({ _id: doc._id });
        summary.mastery_deleted++;
      } catch (e) {
        summary.errors.push({ collection: 'MetaSkillMastery', _id: doc._id, error: e.message });
      }
    }
  }

  // ── 2. DifficultyState ────────────────────────────────────────────────────
  const diffDocs = await findDifficultyToDelete();
  summary.difficulty_to_delete = diffDocs.length;

  for (const doc of diffDocs) {
    if (dryRun) {
      logger.log(`[dry-run] would delete DifficultyState ${doc._id}`);
    } else {
      try {
        await DifficultyState.deleteOne({ _id: doc._id });
        summary.difficulty_deleted++;
      } catch (e) {
        summary.errors.push({ collection: 'DifficultyState', _id: doc._id, error: e.message });
      }
    }
  }

  // ── 3. Notifications — mark, do NOT delete ────────────────────────────────
  if (Notification) {
    const notifs = await findNotificationsToMark();
    summary.notifications_to_mark = notifs.length;

    for (const n of notifs) {
      if (dryRun) {
        logger.log(`[dry-run] would mark Notification ${n._id} as rolled_back`);
      } else {
        try {
          await Notification.updateOne(
            { _id: n._id },
            { $set: { 'data.backfill_rolled_back': true } }
          );
          summary.notifications_marked++;
        } catch (e) {
          summary.errors.push({ collection: 'Notification', _id: n._id, error: e.message });
        }
      }
    }
  }

  return summary;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI entry point
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const args   = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  try {
    const summary = await runRollback({ dryRun });
    console.log('\n=== Coding meta-skills backfill ROLLBACK summary ===');
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

module.exports = {
  runRollback,
  isUntouchedMastery,
  isUntouchedDifficulty,
  findMasteryToDelete,
  findDifficultyToDelete,
  findNotificationsToMark,
  BACKFILL_BATCH_TAG,
};
