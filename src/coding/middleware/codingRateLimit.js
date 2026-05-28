'use strict';

const Redis = require('ioredis');

/**
 * Capstone-specific rate limiter. Keys on (userId, endpoint) NOT request
 * IP, so the proxy-IP collision bug that affects the global rateLimiter
 * doesn't apply here (memory: rate_limiter_bug).
 *
 * Fails OPEN on Redis errors — same posture as the existing limiter, so
 * a Redis blip doesn't lock learners out of their session mid-capstone.
 * Logs the failure so we can detect prolonged Redis outages via the
 * alert pipeline (see capstoneAlerts.js).
 *
 * Usage:
 *   router.post('/run', auth, codingRateLimit({ endpoint: 'run', windowMs: 60_000, max: 20 }), handler)
 *
 * Per-user budgets are intentionally tight on hot endpoints (run, files,
 * voice-reflection) and loose on read endpoints (status, result, replay).
 */

let _redis;
function getRedis() {
  if (!_redis) {
    _redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  }
  return _redis;
}

/**
 * @param {object} opts
 * @param {string} opts.endpoint     — short slug, becomes part of the redis key
 * @param {number} [opts.windowMs=60000]
 * @param {number} [opts.max=60]
 * @param {(req) => string} [opts.keyFn]  — override key derivation; defaults to userId
 */
function codingRateLimit({ endpoint, windowMs = 60_000, max = 60, keyFn } = {}) {
  if (!endpoint) throw new Error('endpoint slug required');

  return async (req, res, next) => {
    const principal =
      typeof keyFn === 'function' ? keyFn(req) : req.user?.userId || req.ip || 'anon';
    const key = `coding-rl:${endpoint}:${principal}`;
    try {
      const r = getRedis();
      const current = await r.incr(key);
      if (current === 1) await r.pexpire(key, windowMs);
      if (current > max) {
        const ttl = await r.pttl(key);
        res.set('Retry-After', Math.ceil(Math.max(0, ttl) / 1000));
        return res.status(429).json({
          error: 'rate_limited',
          endpoint,
          retry_after_ms: Math.max(0, ttl),
        });
      }
      return next();
    } catch (err) {
      // Fail-open + log so the alert pipeline picks up sustained outage.
      // eslint-disable-next-line no-console
      console.warn(`[codingRateLimit] redis error on ${endpoint}: ${err.message}`);
      return next();
    }
  };
}

module.exports = codingRateLimit;
