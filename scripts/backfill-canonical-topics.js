#!/usr/bin/env node
/**
 * One-shot backfill: walk every UserObjective without canonicalTopic
 * (or with canonicalTopic_needsReview=true) and resolve via the
 * canonicalization service. Idempotent — re-running is a no-op for
 * already-canonicalized documents.
 *
 * Usage:
 *   NODE_ENV=production node scripts/backfill-canonical-topics.js [--dry-run]
 */

require('dotenv').config();
const mongoose = require('mongoose');
const UserObjective = require('../src/models/UserObjective');
const topicCanonicalizationService = require('../src/services/topicCanonicalizationService');

const DRY = process.argv.includes('--dry-run');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`[Backfill] connected. dry=${DRY}`);

  const filter = {
    $or: [
      { canonicalTopic: { $exists: false } },
      { canonicalTopic: null },
      { canonicalTopic: '' },
      { canonicalTopic_needsReview: true },
    ],
  };
  const total = await UserObjective.countDocuments(filter);
  console.log(`[Backfill] ${total} objectives to process`);

  let processed = 0;
  let resolved = 0;
  let flagged = 0;

  const cursor = UserObjective.find(filter).cursor();
  for (let doc = await cursor.next(); doc; doc = await cursor.next()) {
    processed++;
    const derivedRaw =
      doc.specifics?.targetRole ||
      doc.specifics?.examName ||
      doc.specifics?.targetSkill ||
      doc.specifics?.toDomain ||
      (doc.topicsOfInterest && doc.topicsOfInterest[0]) ||
      doc.objectiveType;

    try {
      const r = await topicCanonicalizationService.canonicalize(derivedRaw, doc.objectiveType);
      if (DRY) {
        console.log(`  [${processed}/${total}] DRY ${doc._id} raw="${derivedRaw}" → ${r.canonicalTopic} (${r.source})`);
      } else {
        doc.canonicalTopic = r.canonicalTopic;
        doc.canonicalTopic_needsReview = r.source === 'fallback';
        doc.canonicalTopic_lastResolvedAt = new Date();
        await doc.save();
      }
      if (r.source === 'fallback') flagged++;
      resolved++;
    } catch (err) {
      console.warn(`  [${processed}/${total}] ${doc._id} failed: ${err.message}`);
    }

    if (processed % 50 === 0) {
      console.log(`[Backfill] progress: ${processed}/${total}`);
    }
  }

  console.log(`[Backfill] done. processed=${processed} resolved=${resolved} flagged=${flagged}`);
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('[Backfill] fatal:', err);
  process.exit(1);
});
