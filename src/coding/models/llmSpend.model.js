'use strict';

const mongoose = require('mongoose');

/**
 * LLMSpend — append-only ledger of LLM token usage + cost, keyed by the
 * upstream business object that triggered the call.
 *
 * Why a dedicated collection vs adding fields to each session/attempt:
 *   - One session can trigger N LLM calls (eval, anchor-drift re-run,
 *     reflection re-eval, Compass coder turns) — flat fields would either
 *     overflow (per-call array) or under-report (sum only).
 *   - The cost-alert worker scans this collection cheaply for runaway
 *     sessions (sum by session_id > threshold).
 *   - Per-task-id rollups feed the monthly cost-by-model dashboard.
 *
 * Granularity: one document per llmCall(). Retention: 365 days (cost
 * audit horizon); we can drop the TTL if compliance needs longer.
 */

const LLMSpendSchema = new mongoose.Schema(
  {
    // Task ID from llmRouter routing table — e.g. 'capstone_evaluator',
    // 'capstone_anchor_drift_rerun', 'compass_coder', etc.
    task_id: { type: String, required: true, index: true },

    provider: { type: String, enum: ['anthropic', 'google'], required: true },
    model: { type: String, required: true },

    // The upstream object this call belongs to. Null for system-level calls
    // (warm-pool generator runs, etc.).
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    session_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CapstoneSession',
      index: true,
    },
    attempt_id: { type: mongoose.Schema.Types.ObjectId, ref: 'DrillAttempt' },
    bundle_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ArtifactBundle' },

    tokens_in: { type: Number, required: true },
    tokens_out: { type: Number, required: true },
    cost_usd: { type: Number, required: true },
    duration_ms: { type: Number, required: true },

    // 'ok' | 'error' | 'timeout' — used to compute failure rate per task.
    outcome: { type: String, enum: ['ok', 'error', 'timeout'], default: 'ok', index: true },
    error_class: String,

    // Retention sweep
    expires_at: {
      type: Date,
      required: true,
      index: { expireAfterSeconds: 0 },
    },
  },
  { timestamps: true }
);

// Cost-alert hot query: sum(cost_usd) where session_id = X
LLMSpendSchema.index({ session_id: 1, createdAt: -1 });
// Monthly rollup query: { task_id, model } over createdAt range
LLMSpendSchema.index({ task_id: 1, model: 1, createdAt: -1 });

module.exports = mongoose.model('LLMSpend', LLMSpendSchema);
