#!/usr/bin/env node
/**
 * Import pre-populated taxonomy seed (companies / exams / skills / roles)
 * into MongoDB. Idempotent — runs upserts keyed by (slug, type).
 *
 *   node scripts/import-taxonomy-seed.js                  # default path
 *   node scripts/import-taxonomy-seed.js path/to/file.json
 *
 * Re-run any time. Quarterly refresh refreshes the seed file + this script.
 */

const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const TaxonomySeed = require('../src/models/TaxonomySeed');

async function main() {
  const seedPath = process.argv[2] || path.join(__dirname, '..', 'data', 'taxonomy-seed.json');
  if (!fs.existsSync(seedPath)) {
    console.error(`Seed file not found: ${seedPath}`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGO_URI not set in .env');
    process.exit(1);
  }
  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB');

  const stats = { company: 0, exam: 0, skill: 0, role: 0 };

  const batches = [
    { type: 'company', items: raw.companies || [], popularityKey: 'tier' },
    { type: 'exam',    items: raw.exams     || [] },
    { type: 'skill',   items: raw.skills    || [] },
    { type: 'role',    items: raw.roles     || [] },
  ];

  for (const batch of batches) {
    for (const item of batch.items) {
      const slug = item.slug;
      const name = item.name;
      const popularity = batch.type === 'company'
        ? ({ tier1: 100, india_tier1: 95, consulting: 90, finance: 85, india_mass: 80 }[item.tier] || 50)
        : 50;
      await TaxonomySeed.updateOne(
        { slug, type: batch.type },
        {
          $set: {
            type: batch.type,
            slug,
            name,
            nameLower: name.toLowerCase(),
            data: stripPrimitives(item),
            popularity,
            isActive: true,
            source: 'seed',
          },
        },
        { upsert: true }
      );
      stats[batch.type] += 1;
    }
  }

  console.log('Imported:');
  console.log(`  companies: ${stats.company}`);
  console.log(`  exams:     ${stats.exam}`);
  console.log(`  skills:    ${stats.skill}`);
  console.log(`  roles:     ${stats.role}`);

  await mongoose.disconnect();
}

/**
 * Strip top-level slug + name (they're hoisted to the document root) and keep
 * the entity-specific payload on `data`.
 */
function stripPrimitives(item) {
  const { slug, name, ...rest } = item;
  return rest;
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
