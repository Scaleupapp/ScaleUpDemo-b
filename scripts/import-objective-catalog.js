#!/usr/bin/env node
/**
 * Import the curated ObjectiveCatalog from data/objective-catalog.json.
 *
 * SAFETY — this script is INSERT-ONLY and IDEMPOTENT:
 *   - Upserts keyed by (type, canonicalSlug)
 *   - On an existing entry, it ONLY refreshes name / aliases / popularity /
 *     mapsToObjectiveType / category — it NEVER deletes anything, and NEVER
 *     downgrades a 'curated' entry.
 *   - It does not touch any other collection.
 * Safe to run against the production database. Re-runnable any time.
 *
 *   node scripts/import-objective-catalog.js                 # default path
 *   node scripts/import-objective-catalog.js --dry-run       # show what WOULD change, write nothing
 *   node scripts/import-objective-catalog.js path/to/file.json
 */

const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ObjectiveCatalog = require('../src/models/ObjectiveCatalog');

const DRY_RUN = process.argv.includes('--dry-run');

// type → which v1 objectiveType it resolves to
const TYPE_TO_OBJECTIVE = {
  role: 'interview_preparation',
  exam: 'exam_preparation',
  skill: 'upskilling',
  college_prep: 'academic_excellence',
  company: 'interview_preparation', // a company is a modifier on interview_preparation
};

async function main() {
  const seedPath = process.argv.find(a => a.endsWith('.json'))
    || path.join(__dirname, '..', 'data', 'objective-catalog.json');

  if (!fs.existsSync(seedPath)) {
    console.error(`Catalog file not found: ${seedPath}`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGO_URI not set in .env');
    process.exit(1);
  }

  // Build the flat list of catalog entries from the typed buckets.
  const buckets = [
    { type: 'role',         items: raw.roles        || [] },
    { type: 'exam',         items: raw.exams        || [] },
    { type: 'college_prep', items: raw.college_prep || [] },
    { type: 'skill',        items: raw.skills       || [] },
    { type: 'company',      items: raw.companies    || [] },
  ];

  const docs = [];
  for (const bucket of buckets) {
    for (const item of bucket.items) {
      if (!item.name || !item.canonicalSlug) {
        console.warn(`[skip] ${bucket.type} entry missing name/canonicalSlug:`, JSON.stringify(item));
        continue;
      }
      const aliases = Array.isArray(item.aliases) ? item.aliases : [];
      docs.push({
        type: bucket.type,
        name: item.name,
        nameLower: item.name.toLowerCase(),
        canonicalSlug: item.canonicalSlug,
        aliases,
        aliasesLower: aliases.map(a => a.toLowerCase()),
        mapsToObjectiveType: TYPE_TO_OBJECTIVE[bucket.type],
        category: item.category || undefined,
        popularity: typeof item.popularity === 'number' ? item.popularity : 50,
        source: 'curated',
        isActive: true,
      });
    }
  }

  console.log(`Catalog file: ${seedPath}`);
  console.log(`Parsed ${docs.length} curated entries.`);
  if (DRY_RUN) console.log('--- DRY RUN: no writes will be made ---');

  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB.');

  const stats = { inserted: 0, updated: 0, unchanged: 0 };

  for (const doc of docs) {
    const existing = await ObjectiveCatalog.findOne({
      type: doc.type, canonicalSlug: doc.canonicalSlug,
    }).lean();

    if (!existing) {
      if (!DRY_RUN) await ObjectiveCatalog.create(doc);
      stats.inserted += 1;
      if (DRY_RUN) console.log(`  + INSERT  ${doc.type}/${doc.canonicalSlug}`);
      continue;
    }

    // Existing entry — refresh mutable fields only. Never delete, never
    // downgrade source. A 'curated' entry stays 'curated'.
    const needsUpdate =
      existing.name !== doc.name ||
      existing.popularity !== doc.popularity ||
      JSON.stringify(existing.aliases || []) !== JSON.stringify(doc.aliases) ||
      existing.category !== doc.category ||
      existing.mapsToObjectiveType !== doc.mapsToObjectiveType ||
      existing.isActive !== true;

    if (needsUpdate) {
      if (!DRY_RUN) {
        await ObjectiveCatalog.updateOne(
          { type: doc.type, canonicalSlug: doc.canonicalSlug },
          {
            $set: {
              name: doc.name,
              nameLower: doc.nameLower,
              aliases: doc.aliases,
              aliasesLower: doc.aliasesLower,
              mapsToObjectiveType: doc.mapsToObjectiveType,
              category: doc.category,
              popularity: doc.popularity,
              isActive: true,
              // source intentionally NOT touched — never downgrade curated.
            },
          }
        );
      }
      stats.updated += 1;
      if (DRY_RUN) console.log(`  ~ UPDATE  ${doc.type}/${doc.canonicalSlug}`);
    } else {
      stats.unchanged += 1;
    }
  }

  console.log('');
  console.log(`Done.  inserted: ${stats.inserted}  updated: ${stats.updated}  unchanged: ${stats.unchanged}`);
  if (DRY_RUN) console.log('(DRY RUN — nothing was written)');

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
