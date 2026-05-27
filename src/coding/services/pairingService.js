'use strict';

const crypto = require('crypto');
const PairingCode = require('../models/pairingCode.model');

/**
 * Pairing service — mints + redeems the 6-digit handoff code that bridges
 * mobile and laptop (spec §7.2 step 3, §7.3 `session.pair`).
 *
 * Properties we care about:
 *   1. Collision-free at scale — the 6-digit space has 1M values; at our
 *      target traffic (~50 active sessions in peak hour) collisions are
 *      rare but possible, so insert-retry on dup-key.
 *   2. Constant-time redemption — single Mongo query that atomically
 *      finds-and-marks-used, so two simultaneous redemptions of the same
 *      code can't both succeed.
 *   3. Self-purging — codes have a TTL index on `expires_at`, so expired
 *      ones are reaped by Mongo without a cron job.
 *
 * Tests live in src/test/coding/pairingService.test.js (WS2.10).
 */

/** Default validity window — spec §7.2 step 3. */
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_COLLISION_RETRIES = 5;

/**
 * Mint a new 6-digit pairing code for a session.
 *
 * @param {object} args
 * @param {import('mongoose').Types.ObjectId|string} args.userId
 * @param {import('mongoose').Types.ObjectId|string} args.sessionId
 * @param {number} [args.ttlMs] — override default 10-min validity (testing)
 * @returns {Promise<{ code: string, expiresAt: Date }>}
 */
async function mintCode({ userId, sessionId, ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!userId || !sessionId) {
    throw new Error('mintCode requires userId and sessionId');
  }

  let lastErr;
  for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt++) {
    // crypto.randomInt is uniform — important because Math.random can bias
    // toward certain ranges. Pad to 6 digits with leading zeros.
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(Date.now() + ttlMs);
    try {
      await PairingCode.create({
        code,
        user_id: userId,
        session_id: sessionId,
        expires_at: expiresAt,
      });
      return { code, expiresAt };
    } catch (err) {
      // E11000 = duplicate key. Anything else is a real failure — surface.
      if (err && err.code === 11000) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  const failure = new Error(`Pairing code collision after ${MAX_COLLISION_RETRIES} retries`);
  failure.cause = lastErr;
  throw failure;
}

/**
 * Result of a redemption attempt. The shape is a tagged union — `kind` is
 * always present; the other fields depend on success/failure.
 *
 * @typedef {Object} RedeemResult
 * @property {'ok'|'invalid'|'expired'|'used'} kind
 * @property {string} [code]
 * @property {import('mongoose').Types.ObjectId} [userId]
 * @property {import('mongoose').Types.ObjectId} [sessionId]
 * @property {Date} [usedAt]
 */

/**
 * Atomically mark a code as redeemed. Returns the success kind so the route
 * handler can surface the right 404 error code per the OpenAPI spec
 * (`pairing_code_invalid` / `pairing_code_expired` / `pairing_code_used`).
 *
 * The single `findOneAndUpdate` with a filter on `used_at: null` + an expiry
 * check means two simultaneous redemptions race in Mongo, not in our code —
 * only the first wins the update.
 *
 * @param {string} code
 * @returns {Promise<RedeemResult>}
 */
async function redeem(code) {
  if (!code || typeof code !== 'string') {
    return { kind: 'invalid' };
  }

  const now = new Date();
  const doc = await PairingCode.findOneAndUpdate(
    { code, used_at: null, expires_at: { $gt: now } },
    { $set: { used_at: now } },
    { new: true }
  );

  if (doc) {
    return {
      kind: 'ok',
      code: doc.code,
      userId: doc.user_id,
      sessionId: doc.session_id,
      usedAt: doc.used_at,
    };
  }

  // Update missed — figure out why so the caller can return the right error.
  // We don't strictly need this distinction (mobile would treat all three
  // failures the same way), but the OpenAPI spec exposes them so the web
  // pair UI can show specific copy for each.
  const stale = await PairingCode.findOne({ code }).lean();
  if (!stale) return { kind: 'invalid' };
  if (stale.used_at) return { kind: 'used' };
  if (stale.expires_at <= now) return { kind: 'expired' };
  // Fallthrough — race lost between update and lookup; treat as invalid.
  return { kind: 'invalid' };
}

/** Inspect a code without redeeming. Used by status pollers + tests. */
async function peek(code) {
  if (!code) return null;
  return PairingCode.findOne({ code }).lean();
}

module.exports = {
  mintCode,
  redeem,
  peek,
  DEFAULT_TTL_MS,
};
