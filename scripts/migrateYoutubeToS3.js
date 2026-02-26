#!/usr/bin/env node

/**
 * Migration Script: Download existing YouTube videos from DB and re-upload to S3
 *
 * Usage: node scripts/migrateYoutubeToS3.js
 *
 * This finds all Content documents where:
 *   - isYoutubeImport === true
 *   - s3Key is missing (i.e. still pointing to YouTube URLs)
 *
 * For each, it downloads the video + thumbnail and uploads them to S3,
 * then updates the Content document with the new S3 URLs.
 *
 * Safe to run multiple times — skips already-migrated content.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const Content = require('../src/models/Content');
const youtubeDownloadService = require('../src/services/youtubeDownloadService');

const BATCH_SIZE = 1;          // process 1 at a time to minimize temp disk usage
const DELAY_BETWEEN_MS = 1000; // pause between items

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function migrateOne(content) {
  const videoId = content.youtubeVideoId;
  const tag = `[${content._id}] "${content.title}"`;

  try {
    // 1. Download video and upload to S3
    console.log(`  ${tag} — downloading video...`);
    const { videoS3URL, videoS3Key } = await youtubeDownloadService.downloadAndUploadVideo(videoId);

    // 2. Download thumbnail and upload to S3
    let thumbnailS3URL = null;
    let thumbnailS3Key = null;
    if (content.thumbnailURL) {
      console.log(`  ${tag} — downloading thumbnail...`);
      const thumbResult = await youtubeDownloadService.downloadAndUploadThumbnail(videoId, content.thumbnailURL);
      thumbnailS3URL = thumbResult.thumbnailS3URL;
      thumbnailS3Key = thumbResult.thumbnailS3Key;
    }

    // 3. Update the Content document
    await Content.updateOne(
      { _id: content._id },
      {
        $set: {
          contentURL: videoS3URL,
          s3Key: videoS3Key,
          ...(thumbnailS3URL && { thumbnailURL: thumbnailS3URL }),
          ...(thumbnailS3Key && { thumbnailS3Key }),
        },
      }
    );

    console.log(`  ${tag} — MIGRATED`);
    return 'migrated';
  } catch (err) {
    console.error(`  ${tag} — FAILED: ${err.message}`);
    return 'failed';
  }
}

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('ERROR: MONGODB_URI not set.');
    process.exit(1);
  }
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.S3_BUCKET_NAME) {
    console.error('ERROR: AWS/S3 env vars not set.');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('  YouTube → S3 Migration Script');
  console.log('='.repeat(60));
  console.log();

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB.\n');

  // Find all YouTube content that hasn't been migrated yet
  const toMigrate = await Content.find({
    isYoutubeImport: true,
    $or: [
      { s3Key: { $exists: false } },
      { s3Key: null },
      { s3Key: '' },
    ],
  }).select('_id title youtubeVideoId thumbnailURL contentURL');

  console.log(`Found ${toMigrate.length} YouTube content items to migrate.\n`);

  if (toMigrate.length === 0) {
    console.log('Nothing to migrate. All YouTube content already has S3 keys.');
    await mongoose.disconnect();
    process.exit(0);
  }

  const stats = { migrated: 0, failed: 0 };

  // Process in batches
  for (let i = 0; i < toMigrate.length; i += BATCH_SIZE) {
    const batch = toMigrate.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(toMigrate.length / BATCH_SIZE);

    console.log(`\nBatch ${batchNum}/${totalBatches} (${batch.length} items)`);
    console.log('─'.repeat(40));

    for (const item of batch) {
      const r = await migrateOne(item);
      if (r === 'migrated') stats.migrated++;
      else stats.failed++;
    }

    console.log(`  Batch done. Progress: ${stats.migrated + stats.failed}/${toMigrate.length}`);

    if (i + BATCH_SIZE < toMigrate.length) {
      await delay(DELAY_BETWEEN_MS);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('  MIGRATION COMPLETE');
  console.log('='.repeat(60));
  console.log(`  Migrated:  ${stats.migrated}`);
  console.log(`  Failed:    ${stats.failed}`);
  console.log(`  Total:     ${toMigrate.length}`);
  console.log('='.repeat(60));

  await mongoose.disconnect();
  console.log('\nDone.');
  process.exit(stats.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\nFatal error:', err);
  mongoose.disconnect().finally(() => process.exit(1));
});
