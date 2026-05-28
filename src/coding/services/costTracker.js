'use strict';

const LLMSpend = require('../models/llmSpend.model');
const alerts = require('./alerts');

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
  // Best-effort budget alarms — never block the caller. Read thresholds
  // each call so they can be tuned in env without a restart.
  void checkBudgetAlarms({ sessionId: actor.sessionId, userId: actor.userId, taskId, cost });

  return { cost_usd: cost, doc_id: String(doc._id) };
}

const PER_SESSION_ALERT_USD_DEFAULT = 1.0;
const DAILY_GLOBAL_ALERT_USD_DEFAULT = 50.0;

async function checkBudgetAlarms({ sessionId, userId, taskId, cost }) {
  try {
    if (sessionId) {
      const sessTotal = await sessionCostUsd(sessionId);
      const ceiling = Number(process.env.COST_ALERT_PER_SESSION_USD) || PER_SESSION_ALERT_USD_DEFAULT;
      if (sessTotal >= ceiling) {
        await alerts.fire({
          category: 'cost.session-over-budget',
          severity: 'warn',
          title: `Session ${sessionId} crossed $${ceiling.toFixed(2)} LLM spend`,
          dedupKey: `session:${sessionId}`,
          fields: {
            session_id: String(sessionId),
            user_id: String(userId || 'n/a'),
            last_task: String(taskId || 'n/a'),
            last_call_usd: cost.toFixed(6),
            total_usd: sessTotal.toFixed(6),
          },
        });
      }
    }

    // Cheap aggregate — index on createdAt makes this a small scan.
    const dailyCeiling = Number(process.env.COST_ALERT_DAILY_USD) || DAILY_GLOBAL_ALERT_USD_DEFAULT;
    if (dailyCeiling > 0) {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const rows = await LLMSpend.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: null, total: { $sum: '$cost_usd' } } },
      ]);
      const dailyTotal = rows[0]?.total || 0;
      if (dailyTotal >= dailyCeiling) {
        await alerts.fire({
          category: 'cost.daily-over-budget',
          severity: 'error',
          title: `Coding LLM spend last 24h: $${dailyTotal.toFixed(2)} (>= $${dailyCeiling.toFixed(2)})`,
          dedupKey: `daily:${new Date().toISOString().slice(0, 10)}`,
          fields: { total_usd: dailyTotal.toFixed(4), ceiling_usd: dailyCeiling.toFixed(2) },
        });
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[costTracker] budget-alarm check failed:', err.message);
  }
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
