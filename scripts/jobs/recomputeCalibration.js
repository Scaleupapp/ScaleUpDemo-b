#!/usr/bin/env node
/**
 * Recompute per-archetype calibration from accumulated ObjectiveOutcome records.
 * Run via the Run-DB-Migration workflow (or schedule as a weekly cron later).
 * Idempotent — upserts only archetypes that pass MIN_OUTCOMES + curve threshold.
 * Archetypes that are still insufficient are skipped (stale CalibrationModel left as-is;
 * the calibrated branch in getEffectiveTarget falls back to heuristic for them anyway).
 *
 *   node scripts/jobs/recomputeCalibration.js [--dry-run]
 *
 *   --dry-run   compute + log what it WOULD upsert; write nothing to the DB.
 */
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');

const DRY = process.argv.includes('--dry-run');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('[recomputeCalibration] MONGODB_URI not set'); process.exit(1); }

  await mongoose.connect(uri);

  // Require after connect so Mongoose models register against the live connection.
  const dataSvc = require('../../src/services/readiness/calibrationDataService');
  const calib = require('../../src/services/readiness/calibrationService');
  const CalibrationModel = require('../../src/models/CalibrationModel');

  // ── Step 1: pull all resolved outcomes ─────────────────────────────────────
  const rows = await dataSvc.assembleRows();

  if (rows.length === 0) {
    console.log('[recomputeCalibration] 0 outcomes, nothing to calibrate.');
    await mongoose.disconnect();
    return;
  }

  // ── Step 2: counts per archetype (for logging) ──────────────────────────────
  const counts = await dataSvc.countsByArchetype();
  console.log(
    `[recomputeCalibration] ${DRY ? 'DRY-RUN ' : ''}` +
    `total rows=${rows.length}  counts=${JSON.stringify(counts)}`,
  );
  console.log(
    `[recomputeCalibration] min=${calib.MIN_OUTCOMES_PER_ARCHETYPE} threshold=${calib.DEFAULT_THRESHOLD}`,
  );

  // ── Step 3: group by archetype ──────────────────────────────────────────────
  const byArch = {};
  for (const r of rows) {
    if (!byArch[r.archetype]) byArch[r.archetype] = [];
    byArch[r.archetype].push(r);
  }

  // ── Step 4: compute + (optionally) upsert per archetype ────────────────────
  const summary = {};

  for (const [arch, archRows] of Object.entries(byArch)) {
    const model = calib.computeForArchetype(archRows);
    summary[arch] = {
      samples: archRows.length,
      calibrated: !!model,
      target: model ? model.target : null,
      reliabilityN: model ? model.reliabilityN : null,
    };

    if (model && !DRY) {
      await CalibrationModel.updateOne(
        { archetype: arch },
        {
          $set: {
            ...model,
            archetype: arch,
            computedAt: new Date(),
          },
        },
        { upsert: true },
      );
      console.log(
        `[recomputeCalibration] UPSERTED archetype=${arch} target=${model.target} n=${model.reliabilityN}`,
      );
    } else if (model && DRY) {
      console.log(
        `[recomputeCalibration] WOULD UPSERT archetype=${arch} target=${model.target} n=${model.reliabilityN}`,
      );
    } else {
      console.log(
        `[recomputeCalibration] SKIP archetype=${arch} samples=${archRows.length} ` +
        `(below min=${calib.MIN_OUTCOMES_PER_ARCHETYPE} or curve never reaches threshold)`,
      );
    }
  }

  console.log('[recomputeCalibration] result:', JSON.stringify(summary, null, 2));

  await mongoose.disconnect();
}

if (require.main === module) {
  // Force clean exit — Mongoose/Redis handles may keep the event loop alive.
  main()
    .then(() => process.exit(0))
    .catch((e) => { console.error('[recomputeCalibration] FATAL:', e); process.exit(1); });
}
