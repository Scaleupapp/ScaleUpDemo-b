#!/usr/bin/env node
/**
 * Backfill KnowledgeProfile.topicMastery from each user's existing diagnostic.
 *
 * WHY: V2 onboarding's diagnostic stopped seeding the KnowledgeProfile (V1 did
 * it via journeyGenerationService; V2 plan-gen dropped it). We fixed the live
 * path in diagnosticService.finishAttempt — but that only fires on FUTURE
 * diagnostic/recalibration finishes. Users who diagnosed BEFORE that deploy have
 * an empty (or quiz-only) KnowledgeProfile, so the composite readiness can't see
 * their diagnostic baseline. This is the one-time catch-up for that cohort.
 *
 * No wipe, no re-onboarding. For each user with a completed diagnostic we read
 * their LATEST completed attempt and seed the competencies it measured.
 *
 * FILL-GAPS ONLY (the important safety property): we seed a topic ONLY if the
 * user has no existing topicMastery entry for it (case-insensitive). We never
 * blend the diagnostic into an EXISTING topic, because updateMastery's 60/40
 * blend would pull a more-current quiz-driven score back toward an older
 * diagnostic — a regression. So this never lowers anyone's measured mastery.
 *
 * IDEMPOTENT: re-running skips topics already present (including ones this script
 * seeded on a prior run, and ones the live finishAttempt seed already wrote).
 *
 * Readiness itself is computed at READ time (/overview), so we do NOT need to
 * recompute ReadinessSnapshots here — the next overview load picks up the
 * freshly-seeded profile automatically.
 *
 * Run:  node scripts/migrate/backfillKnowledgeFromDiagnostic.js [--dry-run] [--limit=N] [--user=<id>]
 *   --dry-run   report only, write nothing (run this FIRST)
 *   --limit=N   process at most N users (staged rollout)
 *   --user=<id> process a single user (targeted smoke test before full run)
 */
require('dotenv').config();
const mongoose = require('mongoose');
const DiagnosticAttempt = require('../../src/models/DiagnosticAttempt');
const KnowledgeProfile = require('../../src/models/KnowledgeProfile');
const knowledgeService = require('../../src/services/knowledgeService');

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT_ARG = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1], 10) : Infinity;
const USER_ARG = process.argv.find((a) => a.startsWith('--user='));
const ONLY_USER = USER_ARG ? USER_ARG.split('=')[1] : null;

const norm = (s) => String(s == null ? '' : s).toLowerCase().trim();

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }
  await mongoose.connect(mongoUri);

  // Everyone with at least one completed diagnostic (or recalibration) attempt.
  const match = { status: 'completed' };
  if (ONLY_USER) match.userId = new mongoose.Types.ObjectId(ONLY_USER);
  const userIds = await DiagnosticAttempt.distinct('userId', match);
  console.log(`[backfill] candidates with a completed diagnostic: ${userIds.length}${DRY_RUN ? ' (DRY-RUN)' : ''}`);

  let processed = 0;
  let seededUsers = 0;
  let topicsSeeded = 0;
  let skippedNoResults = 0;
  let skippedAllPresent = 0;

  for (const userId of userIds) {
    if (processed >= LIMIT) break;
    processed++;

    // Latest completed attempt = freshest baseline for this user.
    const attempt = await DiagnosticAttempt.findOne({ userId, status: 'completed' })
      .sort({ completedAt: -1 })
      .lean();
    // .lean() turns the Map field into a plain object.
    const results = attempt && attempt.results;
    if (!results || Object.keys(results).length === 0) {
      skippedNoResults++;
      continue;
    }

    const profile = await KnowledgeProfile.findOne({ userId }).lean();
    const existing = new Set((profile?.topicMastery || []).map((t) => norm(t.topic)));

    const topicBreakdown = [];
    for (const [canonical, r] of Object.entries(results)) {
      if (!r || r.notTested || typeof r.score !== 'number') continue;
      if (existing.has(norm(canonical))) continue; // fill-gaps only — never regress
      topicBreakdown.push({ topic: canonical, percentage: r.score });
    }

    if (topicBreakdown.length === 0) {
      skippedAllPresent++;
      continue;
    }

    if (!DRY_RUN) {
      // Same contract as finishAttempt's seed: updateMastery mutates + returns the
      // profile (creating it if absent) but does NOT persist — the caller saves.
      const { profile: p } = await knowledgeService.updateMastery(
        userId,
        topicBreakdown,
        { source: 'diagnostic-backfill', weight: 1.0 }
      );
      if (p && typeof p.save === 'function') await p.save();
    }

    seededUsers++;
    topicsSeeded += topicBreakdown.length;
    if (DRY_RUN || seededUsers <= 20) {
      console.log(`[backfill] user=${userId} +${topicBreakdown.length} topics: ${topicBreakdown.map((t) => t.topic).join(', ')}`);
    }
  }

  console.log(
    `[backfill] ${DRY_RUN ? 'DRY-RUN — no writes' : 'WROTE'} | processed=${processed} ` +
    `seededUsers=${seededUsers} topicsSeeded=${topicsSeeded} ` +
    `skippedNoResults=${skippedNoResults} skippedAllPresent=${skippedAllPresent}`
  );
  await mongoose.disconnect();
}

if (require.main === module) {
  // Force a clean exit. Requiring knowledgeService transitively opens a Redis/
  // BullMQ handle that keeps the event loop alive after disconnect(), so without
  // an explicit exit the process hangs until the CI SSH step times out. Writes
  // are already flushed (awaited + saved) before main() resolves.
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { main };
