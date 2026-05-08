#!/usr/bin/env node
/**
 * One-shot migration: backfill `topicSelfRatings` on UserObjective
 * documents that don't have any. The diagnostic engine (V2) reads
 * topicSelfRatings directly from the active UserObjective, so any
 * legacy/pre-V2 user without it is locked out of starting a diagnostic.
 *
 * Strategy:
 *   1. For each active UserObjective with empty/missing topicSelfRatings:
 *      a. Build targetKey from objectiveType + specifics (canonical or raw).
 *      b. Look up TopicTaxonomy by (objectiveType, targetKey).
 *      c. If a taxonomy exists, seed topicSelfRatings with each canonical
 *         topic name → "familiar" (mid-level default — users can refine
 *         via re-calibration once they complete a diagnostic).
 *      d. If no taxonomy match AND analysis.competencies is non-empty,
 *         fall back to seeding from competency names.
 *      e. Otherwise skip (no signal to derive ratings from).
 *
 * Idempotent: re-running is safe — only touches docs whose
 * topicSelfRatings is missing or empty.
 *
 * Usage:
 *   node scripts/migrate/backfillTopicSelfRatings.js [--dry-run]
 */

const FILTER = {
  status: 'active',
  $or: [
    { topicSelfRatings: { $exists: false } },
    { topicSelfRatings: null },
    { $expr: { $eq: [{ $size: { $ifNull: [{ $objectToArray: '$topicSelfRatings' }, []] } }, 0] } },
  ],
};

const DEFAULT_RATING = 'familiar';

function specificsHaveValue(s) {
  if (!s) return false;
  for (const k of Object.keys(s)) {
    if (s[k] != null && s[k] !== '') return true;
  }
  return false;
}

async function runMigration({
  UserObjective,
  TopicTaxonomy,
  buildTargetKey,
  normalizeSpecifics,
  generateTaxonomyForTargetKey,
  dryRun = false,
  log = () => {},
}) {
  const candidates = await UserObjective.find(FILTER).lean();
  log(`Matched ${candidates.length} UserObjective documents needing backfill.`);

  const summary = {
    matched: candidates.length,
    seededFromTaxonomy: 0,
    seededFromCompetencies: 0,
    seededAfterNormalize: 0,
    seededAfterTaxonomyGen: 0,
    skippedEmptySpecifics: 0,
    skippedNoSignal: 0,
    modified: 0,
    canonicalizedOnly: 0,
    errors: [],
  };

  async function tryTaxonomyLookup(objectiveType, specifics) {
    try {
      const targetKey = buildTargetKey(objectiveType, specifics || {});
      const tax = await TopicTaxonomy.findOne({ objectiveType, targetKey }).lean();
      if (tax && Array.isArray(tax.topics) && tax.topics.length > 0) {
        const ratings = {};
        for (const t of tax.topics) {
          if (t.canonicalName) ratings[t.canonicalName] = DEFAULT_RATING;
        }
        if (Object.keys(ratings).length > 0) return { ratings, targetKey };
      }
      return { ratings: null, targetKey };
    } catch (err) {
      throw err;
    }
  }

  for (const obj of candidates) {
    let ratings = null;
    let source = null;
    let canonicalToPersist = null;

    // 1. Try taxonomy lookup with whatever canonical/specifics we already have
    try {
      const { ratings: r } = await tryTaxonomyLookup(
        obj.objectiveType,
        obj.specificsCanonical || obj.specifics || {},
      );
      if (r) { ratings = r; source = 'taxonomy'; }
    } catch (err) {
      summary.errors.push({ id: String(obj._id), step: 'taxonomy', message: err.message });
    }

    // 2. If no ratings yet AND specifics has *something* but specificsCanonical
    //    is empty, normalize first then retry. This recovers the "has raw
    //    specifics but no canonical" bucket.
    if (!ratings
        && normalizeSpecifics
        && specificsHaveValue(obj.specifics)
        && !specificsHaveValue(obj.specificsCanonical)) {
      try {
        const normalized = await normalizeSpecifics({
          objectiveType: obj.objectiveType,
          specifics: obj.specifics,
        });
        if (normalized && specificsHaveValue(normalized)) {
          canonicalToPersist = normalized;
          const { ratings: r } = await tryTaxonomyLookup(obj.objectiveType, normalized);
          if (r) { ratings = r; source = 'taxonomy-after-normalize'; }
          else if (generateTaxonomyForTargetKey) {
            // 3. No taxonomy match even after normalize — generate one via LLM
            try {
              const targetKey = buildTargetKey(obj.objectiveType, normalized);
              const tax = await generateTaxonomyForTargetKey(targetKey);
              if (tax && Array.isArray(tax.topics) && tax.topics.length > 0) {
                ratings = {};
                for (const t of tax.topics) {
                  if (t.canonicalName) ratings[t.canonicalName] = DEFAULT_RATING;
                }
                if (Object.keys(ratings).length === 0) ratings = null;
                else source = 'taxonomy-generated';
              }
            } catch (err) {
              summary.errors.push({ id: String(obj._id), step: 'generateTaxonomy', message: err.message });
            }
          }
        }
      } catch (err) {
        summary.errors.push({ id: String(obj._id), step: 'normalize', message: err.message });
      }
    }

    // 4. Fall back to analysis.competencies (V1 onboarding shape)
    if (!ratings) {
      const competencies = (obj.analysis && obj.analysis.competencies) || [];
      if (competencies.length > 0) {
        ratings = {};
        for (const c of competencies) {
          if (c && c.name) ratings[c.name] = DEFAULT_RATING;
        }
        if (Object.keys(ratings).length > 0) source = 'competencies';
        else ratings = null;
      }
    }

    if (!ratings) {
      if (!specificsHaveValue(obj.specifics)) summary.skippedEmptySpecifics++;
      else summary.skippedNoSignal++;
      // Even if we couldn't seed ratings, persist canonical if we computed it
      if (canonicalToPersist && !dryRun) {
        try {
          await UserObjective.updateOne(
            { _id: obj._id },
            { $set: { specificsCanonical: canonicalToPersist } },
          );
          summary.canonicalizedOnly++;
        } catch (err) {
          summary.errors.push({ id: String(obj._id), step: 'persistCanonical', message: err.message });
        }
      }
      continue;
    }

    if (source === 'taxonomy') summary.seededFromTaxonomy++;
    else if (source === 'taxonomy-after-normalize') summary.seededAfterNormalize++;
    else if (source === 'taxonomy-generated') summary.seededAfterTaxonomyGen++;
    else if (source === 'competencies') summary.seededFromCompetencies++;

    if (!dryRun) {
      try {
        const update = { topicSelfRatings: ratings };
        if (canonicalToPersist) update.specificsCanonical = canonicalToPersist;
        await UserObjective.updateOne({ _id: obj._id }, { $set: update });
        summary.modified++;
      } catch (err) {
        summary.errors.push({ id: String(obj._id), step: 'update', message: err.message });
      }
    }
  }

  log(`Seeded from taxonomy:                 ${summary.seededFromTaxonomy}`);
  log(`Seeded after normalize → taxonomy:    ${summary.seededAfterNormalize}`);
  log(`Seeded after taxonomy generation:     ${summary.seededAfterTaxonomyGen}`);
  log(`Seeded from analysis.competencies:    ${summary.seededFromCompetencies}`);
  log(`Skipped (empty specifics):            ${summary.skippedEmptySpecifics}`);
  log(`Skipped (no signal despite specifics): ${summary.skippedNoSignal}`);
  log(`specificsCanonical-only updates:      ${summary.canonicalizedOnly}`);
  log(`Modified:                             ${summary.modified}${dryRun ? ' (dry-run)' : ''}`);
  if (summary.errors.length > 0) log(`Errors: ${summary.errors.length}`);
  return summary;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const noLLM = process.argv.includes('--no-llm');
  const mongoose = require('mongoose');
  const UserObjective = require('../../src/models/UserObjective');
  const TopicTaxonomy = require('../../src/models/TopicTaxonomy');
  const { buildTargetKey } = require('../../src/services/diagnostic/topicTaxonomyService');

  // Lazy + optional: only require LLM-backed services when we have an API key.
  let normalizeSpecifics = null;
  let generateTaxonomyForTargetKey = null;
  if (!noLLM && process.env.OPENAI_API_KEY) {
    try {
      ({ normalizeSpecifics } = require('../../src/services/diagnostic/specificsNormalizationService'));
    } catch (_) {}
    try {
      const taxSvc = require('../../src/services/diagnostic/topicTaxonomyService');
      generateTaxonomyForTargetKey = taxSvc.generateTaxonomyForTargetKey || null;
    } catch (_) {}
  }

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI not set'); process.exit(1);
  }
  await mongoose.connect(mongoUri);
  try {
    const result = await runMigration({
      UserObjective,
      TopicTaxonomy,
      buildTargetKey,
      normalizeSpecifics,
      generateTaxonomyForTargetKey,
      dryRun,
      log: (msg) => console.log(msg),
    });
    console.log('DONE', JSON.stringify(result, null, 2));
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

module.exports = { runMigration, FILTER, DEFAULT_RATING };
