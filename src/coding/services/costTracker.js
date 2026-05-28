'use strict';

const LLMSpend = require('../models/llmSpend.model');

/**
 * Cost tracking — converts an llmRouter result into a persisted LLMSpend
 * document. Per the prod-readiness bar, every LLM call from a coding
 * workstream must flow through here so we have a complete spend ledger
 * before billing surprises arrive.
 *
 * Per-task USD pricing is a snapshot of Anthropic + Google list prices.
 * The numbers drift; keep them in one place so we re-tune in one PR.
 * If a model is not in the table, we still persist tokens + duration but
 * cost_usd = 0 and outcome = 'ok' (we don't fail-loud — billing audit is
 * a separate workflow).
 */

const RETENTION_DAYS = 365;

// USD per 1M tokens — keep in sync with provider pricing pages.
// Sourced 2026-05; review quarterly.
const PRICING_PER_M = {
  // Anthropic
  'claude-opus-4-7':            { in: 15.00, out: 75.00 },
  'claude-sonnet-4-6':          { in:  3.00, out: 15.00 },
  'claude-haiku-4-5-20251001':  { in:  0.80, out:  4.00 },
  // Google
  'gemini-2.5-pro':             { in:  1.25, out:  5.00 },
};

/**
 * Compute USD spend for a token usage tuple.
 *
 * @param {string} model
 * @param {{ input_tokens?: number, output_tokens?: number }} usage
 * @returns {number} USD cost, rounded to 6 decimal places
 */
function computeCost(model, usage = {}) {
  const tier = PRICING_PER_M[model];
  if (!tier) return 0;
  const inTok = usage.input_tokens ?? 0;
  const outTok = usage.output_tokens ?? 0;
  const cost = (inTok * tier.in + outTok * tier.out) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/**
 * Persist a single LLM call's spend.
 *
 * @param {object} args
 * @param {object} args.result        — return value of llmRouter.llmCall
 * @param {string} args.taskId        — task id from the routing table
 * @param {object} [args.actor]       — { userId, sessionId, attemptId, bundleId }
 * @param {'ok'|'error'|'timeout'} [args.outcome='ok']
 * @param {string} [args.errorClass]  — set when outcome != 'ok'
 * @returns {Promise<{ cost_usd: number, doc_id: string }>}
 */
async function recordSpend({ result, taskId, actor = {}, outcome = 'ok', errorClass } = {}) {
  // result._meta carries provider/model/duration_ms; result.usage carries tokens.
  const meta = result?._meta || {};
  const usage = result?.usage || {};
  const cost = computeCost(meta.model || '', usage);
  const doc = await LLMSpend.create({
    task_id: taskId || meta.taskId,
    provider: meta.provider,
    model: meta.model,
    user_id: actor.userId || undefined,
    session_id: actor.sessionId || undefined,
    attempt_id: actor.attemptId || undefined,
    bundle_id: actor.bundleId || undefined,
    tokens_in: usage.input_tokens || 0,
    tokens_out: usage.output_tokens || 0,
    cost_usd: cost,
    duration_ms: meta.duration_ms || 0,
    outcome,
    error_class: errorClass,
    expires_at: new Date(Date.now() + RETENTION_DAYS * 24 * 60 * 60 * 1000),
  });
  return { cost_usd: cost, doc_id: String(doc._id) };
}

/**
 * Sum cost for a session — used by the cost-alert worker. Returns 0 when
 * no spend has been recorded yet.
 */
async function sessionCostUsd(sessionId) {
  const rows = await LLMSpend.aggregate([
    { $match: { session_id: typeof sessionId === 'string' ? sessionId : sessionId } },
    { $group: { _id: null, total: { $sum: '$cost_usd' } } },
  ]);
  return rows[0]?.total || 0;
}

module.exports = {
  recordSpend,
  sessionCostUsd,
  computeCost,
  PRICING_PER_M,
};
