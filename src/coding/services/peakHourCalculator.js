'use strict';

/**
 * peakHourCalculator.js
 *
 * Computes the user's most common app-open hour (0-23, local time).
 * Falls back to 19 (7 PM) if insufficient data.
 *
 * Data source: no per-session activity log exists in this codebase — all
 * analytics is shipped externally to Mixpanel and is not queryable from
 * the backend. The `defaultActivityFetcher` therefore reads `User.lastLoginAt`
 * (set on every authenticated request, see authController) as the only
 * locally-available activity signal. This gives at most ONE timestamp per user,
 * so the mode path is never reached via the default fetcher — callers that have
 * richer session data (e.g., a future AppSession collection) should supply a
 * custom `opts.activityFetcher`.
 *
 * Limitation: until a per-session log is introduced, this calculator will
 * almost always return FALLBACK_HOUR (19) for real users because
 * `lastLoginAt` is a single timestamp and falls below MIN_SESSIONS_FOR_MODE.
 * The API shape is intentionally designed so the implementation can be
 * upgraded by dropping in a real activityFetcher without changing call sites.
 */

const MIN_SESSIONS_FOR_MODE = 5;
const FALLBACK_HOUR = 19;

/**
 * Convert a Date (or date-like value) to the local hour (0-23) using
 * the given UTC offset in minutes (default: +330 = IST).
 *
 * @param {Date|string|number|null|undefined} date
 * @param {number} [tzOffsetMinutes=330]  positive = east of UTC
 * @returns {number|null}
 */
function hourOfLocalTime(date, tzOffsetMinutes = 330) {
  if (date == null) return null;
  const ms = (date instanceof Date) ? date.getTime() : new Date(date).getTime();
  if (Number.isNaN(ms)) return null;
  const localMs = ms + tzOffsetMinutes * 60 * 1000;
  return new Date(localMs).getUTCHours();
}

/**
 * Return the most-frequent element of an array, or null if the array is
 * empty/falsy. Ties are broken in favour of the first winner encountered
 * (insertion order of Map).
 *
 * @param {number[]|null|undefined} arr
 * @returns {number|null}
 */
function modeOf(arr) {
  if (!arr || arr.length === 0) return null;
  const counts = new Map();
  for (const v of arr) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null;
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) { best = v; bestCount = c; }
  }
  return best;
}

/**
 * Return the user's peak app-open hour (0-23) derived from activity in the
 * last 30 days. Falls back to FALLBACK_HOUR when fewer than
 * MIN_SESSIONS_FOR_MODE timestamps are available.
 *
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {object} [opts]
 * @param {(userId: *, since: Date) => Promise<Date[]>} [opts.activityFetcher]
 *   Async function that returns an array of Date objects representing
 *   app-open events. Defaults to reading User.lastLoginAt from MongoDB.
 * @param {number} [opts.tzOffsetMinutes=330]  UTC offset in minutes (IST default)
 * @returns {Promise<number>}  hour 0-23
 */
async function peakHourCalculator(userId, opts = {}) {
  const { activityFetcher, tzOffsetMinutes = 330 } = opts;
  if (!userId) throw new Error('userId required');

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  let timestamps = [];
  if (typeof activityFetcher === 'function') {
    timestamps = await activityFetcher(userId, since);
  } else {
    timestamps = await defaultActivityFetcher(userId, since);
  }

  if (!timestamps || timestamps.length < MIN_SESSIONS_FOR_MODE) {
    return FALLBACK_HOUR;
  }

  const hours = timestamps
    .map(t => hourOfLocalTime(t, tzOffsetMinutes))
    .filter(h => h !== null && h >= 0 && h < 24);

  const peak = modeOf(hours);
  return (peak === null || peak === undefined) ? FALLBACK_HOUR : peak;
}

/**
 * Default activity fetcher — reads User.lastLoginAt (the only per-user
 * timestamp available locally). Returns an empty array if the user has
 * no lastLoginAt or cannot be found.
 *
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {Date} _since  (unused with single-timestamp approach)
 * @returns {Promise<Date[]>}
 */
async function defaultActivityFetcher(userId, _since) {
  let User;
  try {
    User = require('../../models/User');
  } catch (e) {
    try {
      User = require('../../models/user.model');
    } catch (e2) {
      return [];
    }
  }

  const user = await User.findById(userId).select('lastLoginAt').lean();
  if (!user) return [];
  const ts = user.lastLoginAt;
  return ts ? [new Date(ts)] : [];
}

module.exports = {
  peakHourCalculator,
  hourOfLocalTime,
  modeOf,
  FALLBACK_HOUR,
  MIN_SESSIONS_FOR_MODE,
};
