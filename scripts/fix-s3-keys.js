/**
 * One-time migration: Extract s3Key from contentURL for existing content.
 *
 * Run on the server:
 *   cd /home/ubuntu/scaleup-backend && node scripts/fix-s3-keys.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Content = require('../src/models/Content');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  // Fix s3Key: extract from contentURL
  const docs = await Content.find({ s3Key: null, contentURL: { $ne: null } });
  console.log(`Found ${docs.length} documents with missing s3Key`);

  for (const doc of docs) {
    const match = doc.contentURL.match(/\.amazonaws\.com\/(.+)$/);
    if (match) {
      doc.s3Key = match[1];
      await doc.save();
      console.log(`  Fixed: ${doc.title} → s3Key: ${doc.s3Key}`);
    }
  }

  console.log('Done');
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
