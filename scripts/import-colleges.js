#!/usr/bin/env node
/**
 * Import colleges into MongoDB from the prepared JSON file.
 * Usage: MONGODB_URI=... node scripts/import-colleges.js /path/to/colleges_final.json
 */

require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const College = require('../src/models/College');

const MONGODB_URI = process.env.MONGODB_URI;
const filePath = process.argv[2] || path.join(__dirname, '..', 'data', 'colleges.json');

async function run() {
  console.log('Connecting to MongoDB...');
  await mongoose.connect(MONGODB_URI);
  console.log('Connected.');

  // Check if already imported
  const existing = await College.countDocuments();
  if (existing > 0) {
    console.log(`Already have ${existing} colleges in DB. Drop collection first if you want to re-import.`);
    console.log('To re-import: db.colleges.drop() in mongo shell, then run again.');
    await mongoose.disconnect();
    return;
  }

  console.log(`Reading ${filePath}...`);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  console.log(`Loaded ${data.length} records.`);

  // Insert in batches of 5000
  const batchSize = 5000;
  let inserted = 0;
  for (let i = 0; i < data.length; i += batchSize) {
    const batch = data.slice(i, i + batchSize);
    await College.insertMany(batch, { ordered: false });
    inserted += batch.length;
    console.log(`  Inserted ${inserted}/${data.length}`);
  }

  // Create indexes
  console.log('Creating indexes...');
  await College.collection.createIndex({ nameNormalized: 1 });
  await College.collection.createIndex({ name: 'text', nameNormalized: 'text' });

  console.log(`Done! ${inserted} colleges imported.`);
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
