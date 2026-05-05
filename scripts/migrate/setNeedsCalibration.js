#!/usr/bin/env node
/**
 * One-shot migration: flag every existing UserObjective without
 * topicSelfRatings as `needsCalibration: true` so the legacy-user
 * banner can prompt them to calibrate.
 *
 * Usage:
 *   node scripts/migrate/setNeedsCalibration.js [--dry-run]
 *
 * Idempotent: re-running is safe (only matches docs missing the field
 * or with an empty topicSelfRatings map).
 */

const FILTER = {
  $or: [
    { topicSelfRatings: { $exists: false } },
    { topicSelfRatings: null },
    { topicSelfRatings: { $size: 0 } }, // arrays just in case (Mongoose Map serializes oddly)
    { $expr: { $eq: [{ $size: { $ifNull: [{ $objectToArray: '$topicSelfRatings' }, []] } }, 0] } },
  ],
};

async function runMigration({ Model, dryRun = false, log = () => {} }) {
  const matched = await Model.countDocuments(FILTER);
  log(`Matched ${matched} UserObjective documents.`);
  if (dryRun) {
    log('--dry-run: no writes performed.');
    return { matched, modified: 0 };
  }
  if (matched === 0) return { matched: 0, modified: 0 };
  const result = await Model.updateMany(FILTER, { $set: { needsCalibration: true } });
  const modified = result.modifiedCount ?? result.nModified ?? 0;
  log(`Modified ${modified} documents.`);
  return { matched, modified };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const mongoose = require('mongoose');
  const UserObjective = require('../../src/models/UserObjective');

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI not set'); process.exit(1);
  }
  await mongoose.connect(mongoUri);
  try {
    const result = await runMigration({
      Model: UserObjective,
      dryRun,
      log: (msg) => console.log(msg),
    });
    console.log('DONE', JSON.stringify(result));
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

module.exports = { runMigration, FILTER };
