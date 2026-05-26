'use strict';

/**
 * Scheduled Generator Quota Worker
 *
 * Computes how many ArtifactBundles are needed per (role_track × drill_subtype × difficulty)
 * bucket to reach a target library size, then enqueues generation jobs to
 * contentGeneratorQueue. The queue consumer (T5) picks up and runs the pipeline.
 *
 * The actual cron schedule is wired externally (ops task). This module just
 * exports runScheduledGeneration() so it can be called from any scheduler.
 */

const { ArtifactBundle } = require('../models');

const ROLE_TRACKS    = ['swe', 'ds', 'ai_eng'];
const DRILL_SUBTYPES = ['prompt', 'verify', 'decompose', 'refactor'];
const DIFFICULTIES   = ['easy', 'medium', 'hard'];

// Phase A: all role_tracks default to python.
// Spec allows js/ts/java/sql but starts with python.
const DEFAULT_LANGUAGE = { swe: 'python', ds: 'python', ai_eng: 'python' };

const MAX_PER_RUN               = 20;
const DEFAULT_TARGET_LIBRARY_SIZE = 120;

/**
 * Queries ArtifactBundle for active/validated bundles grouped by
 * role_track × drill_subtype × difficulty.
 *
 * @returns {Object} currentCounts — { swe: { prompt: { easy: N, ... }, ... }, ... }
 */
async function getCurrentCounts() {
  const docs = await ArtifactBundle.aggregate([
    { $match: { type: 'drill', status: { $in: ['active', 'validated'] } } },
    {
      $group: {
        _id: {
          role_track:    '$role_track',
          drill_subtype: '$drill_subtype',
          difficulty:    '$difficulty',
        },
        count: { $sum: 1 },
      },
    },
  ]);

  // Build a fully-initialised zero map so callers never hit undefined
  const counts = {};
  for (const rt of ROLE_TRACKS) {
    counts[rt] = {};
    for (const sub of DRILL_SUBTYPES) {
      counts[rt][sub] = {};
      for (const diff of DIFFICULTIES) counts[rt][sub][diff] = 0;
    }
  }

  for (const d of docs) {
    const { role_track, drill_subtype, difficulty } = d._id;
    // Guard against unknown enum values returned from a dirty DB
    if (counts[role_track] && counts[role_track][drill_subtype]) {
      counts[role_track][drill_subtype][difficulty] = d.count;
    }
  }

  return counts;
}

/**
 * Computes which buckets are understocked and by how much, then caps the
 * total number of new generations at MAX_PER_RUN.
 *
 * @param {Object} options
 * @param {number} options.targetLibrarySize  — default 120
 * @param {Object} options.currentCounts       — from getCurrentCounts()
 * @returns {Array<{ role_track, drill_subtype, difficulty, count }>}
 */
function computeQuotaPlan({ targetLibrarySize, currentCounts }) {
  const buckets        = ROLE_TRACKS.length * DRILL_SUBTYPES.length * DIFFICULTIES.length; // 36
  const targetPerBucket = Math.ceil(targetLibrarySize / buckets); // ceil(120/36) = 4

  const plan = [];
  for (const role_track of ROLE_TRACKS) {
    for (const drill_subtype of DRILL_SUBTYPES) {
      for (const difficulty of DIFFICULTIES) {
        const current = currentCounts[role_track][drill_subtype][difficulty];
        const needed  = Math.max(0, targetPerBucket - current);
        if (needed > 0) {
          plan.push({ role_track, drill_subtype, difficulty, count: needed });
        }
      }
    }
  }

  // Cap total at MAX_PER_RUN to avoid blowing LLM budget in one tick
  let remaining = MAX_PER_RUN;
  const capped  = [];
  for (const entry of plan) {
    if (remaining <= 0) break;
    const take = Math.min(entry.count, remaining);
    capped.push({ ...entry, count: take });
    remaining -= take;
  }

  return capped;
}

/**
 * Adds one BullMQ job per unit of work in the plan.
 *
 * @param {Array}  plan   — output of computeQuotaPlan
 * @param {Object} queue  — BullMQ Queue instance (or stub)
 * @returns {number}      — number of jobs enqueued
 */
async function enqueueQuotaJobs(plan, queue) {
  let enqueued = 0;
  for (const entry of plan) {
    for (let i = 0; i < entry.count; i++) {
      await queue.add('generate-bundle', {
        role_track:    entry.role_track,
        drill_subtype: entry.drill_subtype,
        difficulty:    entry.difficulty,
        language:      DEFAULT_LANGUAGE[entry.role_track],
      });
      enqueued++;
    }
  }
  return enqueued;
}

/**
 * Top-level orchestration function. Called by the scheduler or directly in tests.
 *
 * Uses lazy-require for the queue (option b: queue can be injected) to avoid
 * circular dependency issues when workers/index.js requires this file.
 *
 * @param {Object} [options]
 * @param {number} [options.targetLibrarySize=120]
 * @param {Object} [options.queue]  — injected queue (for tests); falls back to lazy-require
 * @returns {{ planned: number, enqueued: number }}
 */
async function runScheduledGeneration({ targetLibrarySize = DEFAULT_TARGET_LIBRARY_SIZE, queue } = {}) {
  // Lazy-require to avoid circular dep: index.js → this file → index.js
  const q = queue || require('./index').contentGeneratorQueue;

  const currentCounts = await module.exports.getCurrentCounts();
  const plan          = computeQuotaPlan({ targetLibrarySize, currentCounts });
  const planned       = plan.reduce((sum, e) => sum + e.count, 0);
  const enqueued      = await enqueueQuotaJobs(plan, q);

  return { planned, enqueued };
}

module.exports = {
  runScheduledGeneration,
  computeQuotaPlan,
  enqueueQuotaJobs,
  getCurrentCounts,
  DEFAULT_TARGET_LIBRARY_SIZE,
  MAX_PER_RUN,
};
