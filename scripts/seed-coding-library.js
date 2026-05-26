#!/usr/bin/env node
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const models = require('../src/coding/models');
const { validateBundle } = require('../src/coding/services/bundleSchema');
const { computeContentHash } = require('../src/coding/services/contentHash');

const SEED_ROOT = path.join(__dirname, '..', 'seed-content', 'coding');

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/**
 * Recursively find all *.json files under `root`.
 * Returns an empty array if `root` does not exist.
 *
 * @param {string} root
 * @returns {string[]}
 */
function findSeedFiles(root) {
  const results = [];
  if (!fs.existsSync(root)) return results;

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.json')) results.push(full);
    }
  }
  walk(root);
  return results;
}

// ---------------------------------------------------------------------------
// Core import logic (exported for testability)
// ---------------------------------------------------------------------------

/**
 * Import all seed JSON files found under `root` into the `artifact_bundles`
 * collection.  Idempotent: re-running does not duplicate documents — it uses
 * `content_hash` as the deduplicate key, updating status/human_reviewed on
 * existing docs.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.dryRun=false]   - Log intent but skip all DB writes.
 * @param {string}  [opts.root]           - Override seed directory (useful in tests).
 * @param {object}  [opts.logger]         - Logging sink; defaults to console.
 * @returns {Promise<object>}             - Summary counts + error list.
 */
async function importSeeds({ dryRun = false, root = SEED_ROOT, logger = console } = {}) {
  const files = findSeedFiles(root);
  const summary = {
    found: files.length,
    validated: 0,
    imported: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  for (const file of files) {
    const rel = path.relative(root, file);

    // --- Parse ---
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      summary.failed++;
      summary.errors.push({ file: rel, error: `parse: ${e.message}` });
      continue;
    }

    // --- Strip fields that the script controls ---
    delete raw.status;
    delete raw.generated_by;
    delete raw.content_hash;

    const hash = computeContentHash(raw);
    const candidate = {
      ...raw,
      content_hash: hash,
      status: 'active',
      generated_by: {
        generator_model: 'human',
        validator_model: 'human',
        validated_at: new Date(),
        human_reviewed: true,
      },
    };

    // --- Validate ---
    const { error, value } = validateBundle(candidate);
    if (error) {
      summary.failed++;
      summary.errors.push({ file: rel, error: `validate: ${error.message}` });
      continue;
    }
    summary.validated++;

    // --- Dry-run shortcut ---
    if (dryRun) {
      summary.skipped++;
      logger.log(`[dry-run] would upsert: ${rel} (hash=${hash.slice(0, 8)})`);
      continue;
    }

    // --- Upsert by content_hash (idempotent) ---
    // Re-read ArtifactBundle each iteration so tests can swap the stub.
    const ArtifactBundle = models.ArtifactBundle;

    const existing = await ArtifactBundle.findOne({ content_hash: hash });
    if (existing) {
      await ArtifactBundle.updateOne(
        { _id: existing._id },
        {
          $set: {
            status: 'active',
            'generated_by.human_reviewed': true,
          },
        },
      );
      summary.updated++;
      logger.log(`[update] ${rel} (existing _id=${existing._id})`);
    } else {
      const saved = await ArtifactBundle.create(value);
      summary.imported++;
      logger.log(`[import] ${rel} → ${saved._id}`);
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  if (!dryRun) {
    if (!process.env.MONGODB_URI) {
      console.error('MONGODB_URI not set');
      process.exit(1);
    }
    await mongoose.connect(process.env.MONGODB_URI);
  }

  try {
    const summary = await importSeeds({ dryRun });
    console.log('\n=== Seed import summary ===');
    console.log(JSON.stringify(summary, null, 2));
    if (summary.failed > 0) process.exit(2);
  } finally {
    if (!dryRun) await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}

module.exports = { importSeeds, findSeedFiles };
