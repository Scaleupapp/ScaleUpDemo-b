/**
 * User Inference Service — BUG-8 Phase 9
 *
 * Records inferences the system makes about a user (cognitive traits,
 * goal blockers, etc.) so they can be surfaced in a transparent
 * "How we're personalising for you" panel. The user can confirm or
 * dismiss each inference; dismissals suppress that inference everywhere.
 *
 * Public API:
 *   recordInference(userId, key, kind, title, description, payload?)
 *     Upserts an inference. If it already exists with a non-pending
 *     status, leaves the user's choice intact.
 *   listForUser(userId, opts?)
 *     Returns all inferences for the user. Defaults to pending only.
 *   resolve(userId, key, status)
 *     Sets the inference status to 'confirmed' or 'dismissed'.
 *   isDismissed(userId, key)
 *     Cheap check used by other services (e.g. progressInsightsService)
 *     to skip suppressed inferences.
 */

const UserInference = require('../models/UserInference');

const _dismissCache = new Map(); // userId -> { keys: Set, expiresAt }
const DISMISS_CACHE_TTL_MS = 5 * 60 * 1000;

async function recordInference(userId, key, kind, title, description, payload = null) {
  if (!userId || !key || !title || !description) return null;
  const existing = await UserInference.findOne({ userId, key });
  if (existing) {
    // Refresh display fields — but never overwrite the user's resolution
    existing.title = title;
    existing.description = description;
    if (payload !== null) existing.payload = payload;
    await existing.save();
    return existing;
  }
  return UserInference.create({
    userId, key, kind, title, description, payload,
    status: 'pending', firstSurfacedAt: new Date(),
  });
}

async function listForUser(userId, { includeResolved = false } = {}) {
  const filter = includeResolved ? { userId } : { userId, status: 'pending' };
  return UserInference.find(filter).sort({ firstSurfacedAt: -1 }).lean();
}

async function resolve(userId, key, status) {
  if (!['confirmed', 'dismissed'].includes(status)) {
    throw new Error(`invalid status: ${status}`);
  }
  const result = await UserInference.findOneAndUpdate(
    { userId, key },
    { $set: { status, resolvedAt: new Date() } },
    { new: true }
  );
  // Bust the dismiss cache for this user
  _dismissCache.delete(String(userId));
  return result;
}

async function isDismissed(userId, key) {
  const cached = _dismissCache.get(String(userId));
  if (cached && cached.expiresAt > Date.now()) {
    return cached.keys.has(key);
  }
  const dismissed = await UserInference.find({ userId, status: 'dismissed' }).select('key').lean();
  const keys = new Set(dismissed.map(d => d.key));
  _dismissCache.set(String(userId), { keys, expiresAt: Date.now() + DISMISS_CACHE_TTL_MS });
  return keys.has(key);
}

module.exports = {
  recordInference,
  listForUser,
  resolve,
  isDismissed,
};
