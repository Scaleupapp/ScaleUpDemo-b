'use strict';

const Redis = require('ioredis');

/**
 * Compass-Coder daily token budget (spec §10 "daily token budget tracked
 * identically"). Mirrors the Compass orchestrator pattern but lives in a
 * separate Redis namespace because coder turns are tool-use loops that
 * burn 5–10× the tokens of a chat turn — separate ceiling needed.
 *
 * The check is atomic: incrby the estimate, compare against cap, decrby
 * on over-budget. Falls open on Redis outage (logged + true) so a brief
 * Redis blip doesn't lock learners out of a paid feature.
 *
 * Tier handling: cap defaults to DAILY_TOKEN_CAP_FREE. Pro-tier wiring is
 * a one-line addition once we ship paid tiers.
 */

const DAILY_TOKEN_CAP_FREE = 100_000; // ≈ 30–50 coder turns of typical size
const DAILY_TOKEN_CAP_PRO = 500_000;

let _redis;
function getRedis() {
  if (!_redis) {
    _redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  }
  return _redis;
}

function budgetKey(userId) {
  const today = new Date().toISOString().split('T')[0];
  return `coder:budget:${userId}:${today}`;
}

function secondsUntilEndOfDayUTC() {
  const now = new Date();
  const tomorrow = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  );
  return Math.max(60, Math.ceil((tomorrow - now) / 1000));
}

/**
 * Reserve `estimatedTokens` against the user's daily cap. Returns true if
 * the reservation succeeded; false if it would exceed the cap.
 *
 * Caller MUST call reconcile() after the LLM call to charge actual usage
 * (positive delta if estimate was too low; negative to refund).
 *
 * Falls open on Redis errors.
 *
 * @param {string} userId
 * @param {number} estimatedTokens
 * @param {object} [opts]
 * @param {'free'|'pro'} [opts.tier='free']
 * @returns {Promise<{ ok: boolean, used: number, cap: number, key: string }>}
 */
async function reserve(userId, estimatedTokens, { tier = 'free' } = {}) {
  const cap = tier === 'pro' ? DAILY_TOKEN_CAP_PRO : DAILY_TOKEN_CAP_FREE;
  if (!userId || !estimatedTokens || estimatedTokens <= 0) {
    return { ok: true, used: 0, cap, key: budgetKey(userId || 'noop') };
  }
  const redis = getRedis();
  const key = budgetKey(userId);
  try {
    const newTotal = await redis.incrby(key, estimatedTokens);
    if (newTotal === estimatedTokens) {
      await redis.expire(key, secondsUntilEndOfDayUTC());
    }
    if (newTotal > cap) {
      await redis.decrby(key, estimatedTokens);
      return { ok: false, used: newTotal - estimatedTokens, cap, key };
    }
    return { ok: true, used: newTotal, cap, key };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[coderBudget] Redis reserve failed (falling open):', err.message);
    return { ok: true, used: 0, cap, key };
  }
}

/**
 * Charge actual_tokens minus already-reserved. Use after the LLM call
 * settles so the counter reflects true usage.
 *
 * @param {string} userId
 * @param {number} actualTokens
 * @param {number} reservedTokens — the amount passed to reserve()
 */
async function reconcile(userId, actualTokens, reservedTokens) {
  if (!userId) return;
  const delta = (actualTokens || 0) - (reservedTokens || 0);
  if (delta === 0) return;
  const redis = getRedis();
  try {
    await redis.incrby(budgetKey(userId), delta);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[coderBudget] Redis reconcile failed:', err.message);
  }
}

/**
 * Refund a previously-reserved amount in full — used when the LLM call
 * errors before consuming tokens.
 */
async function refund(userId, reservedTokens) {
  if (!userId || !reservedTokens) return;
  try {
    await getRedis().decrby(budgetKey(userId), reservedTokens);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[coderBudget] Redis refund failed:', err.message);
  }
}

/** Current usage snapshot — for diagnostic endpoint / cap-reached banner. */
async function getUsage(userId, { tier = 'free' } = {}) {
  const cap = tier === 'pro' ? DAILY_TOKEN_CAP_PRO : DAILY_TOKEN_CAP_FREE;
  try {
    const used = parseInt((await getRedis().get(budgetKey(userId))) || '0', 10);
    return { used, cap, remaining: Math.max(0, cap - used) };
  } catch {
    return { used: 0, cap, remaining: cap };
  }
}

module.exports = {
  reserve,
  reconcile,
  refund,
  getUsage,
  DAILY_TOKEN_CAP_FREE,
  DAILY_TOKEN_CAP_PRO,
};
