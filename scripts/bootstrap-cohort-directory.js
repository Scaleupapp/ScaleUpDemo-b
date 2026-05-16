#!/usr/bin/env node
/**
 * One-shot bootstrap: aggregate UserObjective by canonicalTopic, seed
 * CohortDirectory with one entry per. memberCount from group size,
 * weeklyAttempts from a 7-day ChallengeAttempt aggregate, historicalStats
 * from a 30-day aggregate, personaGhosts generated and persisted.
 *
 * Usage:
 *   NODE_ENV=production node scripts/bootstrap-cohort-directory.js [--dry-run]
 */

require('dotenv').config();
const mongoose = require('mongoose');
const UserObjective = require('../src/models/UserObjective');
const ChallengeAttempt = require('../src/models/ChallengeAttempt');
const DailyChallenge = require('../src/models/DailyChallenge');
const CohortDirectory = require('../src/models/CohortDirectory');
const cohortDirectoryService = require('../src/services/cohortDirectoryService');
const { findBySlug } = require('../src/config/canonicalTopics');

const DRY = process.argv.includes('--dry-run');

function _weeksAgo(n) { return new Date(Date.now() - n * 7 * 24 * 60 * 60 * 1000); }

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`[Bootstrap] connected. dry=${DRY}`);

  // Group active+primary objectives by canonicalTopic.
  const groups = await UserObjective.aggregate([
    { $match: { status: 'active', isPrimary: true, canonicalTopic: { $exists: true, $ne: null, $ne: '' } } },
    { $group: {
        _id: '$canonicalTopic',
        memberCount: { $sum: 1 },
        objectiveTypes: { $addToSet: '$objectiveType' },
    } },
  ]);
  console.log(`[Bootstrap] ${groups.length} cohorts to seed`);

  // 7-day attempt counts.
  const weekAgo = _weeksAgo(1);
  const attemptAgg = await ChallengeAttempt.aggregate([
    { $match: { completedAt: { $gte: weekAgo } } },
    { $lookup: { from: 'dailychallenges', localField: 'challengeId', foreignField: '_id', as: 'challenge' } },
    { $unwind: '$challenge' },
    { $group: { _id: '$challenge.topic', count: { $sum: 1 } } },
  ]);
  const weeklyAttemptsByTopic = new Map(attemptAgg.map(a => [a._id, a.count]));

  // 30-day historical stats (average + p90 of handicappedScore).
  const monthAgo = _weeksAgo(4);
  const statsAgg = await ChallengeAttempt.aggregate([
    { $match: { completedAt: { $gte: monthAgo }, handicappedScore: { $exists: true } } },
    { $lookup: { from: 'dailychallenges', localField: 'challengeId', foreignField: '_id', as: 'challenge' } },
    { $unwind: '$challenge' },
    { $group: { _id: '$challenge.topic', scores: { $push: '$handicappedScore' } } },
  ]);
  const statsByTopic = new Map();
  for (const s of statsAgg) {
    const sorted = [...s.scores].sort((a, b) => a - b);
    const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    const p90 = sorted[Math.floor(sorted.length * 0.9)] || sorted[sorted.length - 1] || 0;
    statsByTopic.set(s._id, { avg, p90, sampleSize: sorted.length });
  }

  let created = 0, updated = 0;
  for (const g of groups) {
    const canonicalTopic = g._id;
    const meta = findBySlug(canonicalTopic);
    const personas = cohortDirectoryService._internal.generatePersonaGhosts(canonicalTopic);
    const stats = statsByTopic.get(canonicalTopic) || { avg: 0, p90: 0, sampleSize: 0 };
    const payload = {
      canonicalTopic,
      displayName: meta?.display || canonicalTopic,
      objectiveTypes: g.objectiveTypes,
      memberCount: g.memberCount,
      weeklyAttempts: weeklyAttemptsByTopic.get(canonicalTopic) || 0,
      isActive: true,
      personaGhosts: personas,
      historicalStats: {
        last30dAverageScore: Math.round(stats.avg),
        last30dP90Score: Math.round(stats.p90),
        sampleSize: stats.sampleSize,
        refreshedAt: new Date(),
      },
    };
    if (DRY) {
      console.log(`  DRY ${canonicalTopic} members=${payload.memberCount} attempts=${payload.weeklyAttempts}`);
      continue;
    }
    const existed = await CohortDirectory.exists({ canonicalTopic });
    await CohortDirectory.updateOne({ canonicalTopic }, { $set: payload }, { upsert: true });
    if (existed) updated++; else created++;
  }

  console.log(`[Bootstrap] done. created=${created} updated=${updated}`);
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('[Bootstrap] fatal:', err);
  process.exit(1);
});
