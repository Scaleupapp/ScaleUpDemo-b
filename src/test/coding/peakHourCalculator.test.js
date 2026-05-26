'use strict';

/**
 * Unit tests for src/coding/services/peakHourCalculator.js
 *
 * No DB connection required — all DB access is injected via opts.activityFetcher.
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const {
  peakHourCalculator,
  hourOfLocalTime,
  modeOf,
  FALLBACK_HOUR,
  MIN_SESSIONS_FOR_MODE,
} = require('../../coding/services/peakHourCalculator');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build n Date objects all landing at the given local hour (for tzOffsetMinutes). */
function timestampsAtHour(hour, count, tzOffsetMinutes = 330) {
  // We want hourOfLocalTime(date, tzOffset) === hour.
  // hourOfLocalTime computes: localMs = utcMs + tzOffset*60*1000, then returns getUTCHours().
  // So we need: getUTCHours(utcMs + tz*60*1000) === hour.
  // Use Date.UTC for the day base (avoids local-timezone ambiguity), subtract tz offset,
  // add the target hour: the result localMs will have getUTCHours() === hour exactly.
  const dates = [];
  for (let i = 0; i < count; i++) {
    const dayBaseMs = Date.UTC(2025, 0, 1 + i, 0, 0, 0); // UTC midnight of day i
    const utcMs = dayBaseMs - tzOffsetMinutes * 60 * 1000 + hour * 60 * 60 * 1000;
    dates.push(new Date(utcMs));
  }
  return dates;
}

const FAKE_USER_ID = 'user_abc123';

// ── 1. hourOfLocalTime: UTC midnight + IST offset → local hour 5 ──────────────

test('hourOfLocalTime: UTC midnight gives hour 5 with IST offset (+330 min)', () => {
  // UTC 2025-01-01T00:00:00Z + 330 min = 2025-01-01T05:30 IST → hour 5
  const utcMidnight = new Date('2025-01-01T00:00:00.000Z');
  assert.strictEqual(hourOfLocalTime(utcMidnight, 330), 5);
});

// ── 2. hourOfLocalTime: null / invalid input → null ───────────────────────────

test('hourOfLocalTime(null) → null', () => {
  assert.strictEqual(hourOfLocalTime(null), null);
});

test('hourOfLocalTime(undefined) → null', () => {
  assert.strictEqual(hourOfLocalTime(undefined), null);
});

test('hourOfLocalTime("not-a-date") → null', () => {
  assert.strictEqual(hourOfLocalTime('not-a-date', 330), null);
});

// ── 3. modeOf: returns most common value ──────────────────────────────────────

test('modeOf([7, 7, 9, 7, 12]) → 7', () => {
  assert.strictEqual(modeOf([7, 7, 9, 7, 12]), 7);
});

test('modeOf([9, 12]) → first winner when tied (any of them)', () => {
  const result = modeOf([9, 12]);
  assert.ok(result === 9 || result === 12, `got ${result}`);
});

// ── 4. modeOf: empty / null → null ────────────────────────────────────────────

test('modeOf([]) → null', () => {
  assert.strictEqual(modeOf([]), null);
});

test('modeOf(null) → null', () => {
  assert.strictEqual(modeOf(null), null);
});

// ── 5. peakHourCalculator: empty fetcher → FALLBACK_HOUR (19) ─────────────────

test('peakHourCalculator: empty activity list → FALLBACK_HOUR', async () => {
  const result = await peakHourCalculator(FAKE_USER_ID, {
    activityFetcher: async () => [],
  });
  assert.strictEqual(result, FALLBACK_HOUR);
  assert.strictEqual(FALLBACK_HOUR, 19);
});

// ── 6. Below MIN_SESSIONS_FOR_MODE (4 timestamps) → fallback ─────────────────

test('peakHourCalculator: fewer than MIN_SESSIONS_FOR_MODE sessions → FALLBACK_HOUR', async () => {
  assert.ok(MIN_SESSIONS_FOR_MODE >= 5, 'sanity: threshold should be at least 5');
  const timestamps = timestampsAtHour(14, MIN_SESSIONS_FOR_MODE - 1);
  const result = await peakHourCalculator(FAKE_USER_ID, {
    activityFetcher: async () => timestamps,
  });
  assert.strictEqual(result, FALLBACK_HOUR);
});

// ── 7. 6 timestamps clustered at hour 21 → returns 21 ────────────────────────

test('peakHourCalculator: 6 timestamps at hour 21 → 21', async () => {
  const timestamps = timestampsAtHour(21, 6);
  const result = await peakHourCalculator(FAKE_USER_ID, {
    activityFetcher: async () => timestamps,
    tzOffsetMinutes: 330,
  });
  assert.strictEqual(result, 21);
});

// ── 8. Mixed: 8 at hour 19, 3 at hour 7 → mode is 19 ────────────────────────

test('peakHourCalculator: 8 sessions at hour 19 and 3 at hour 7 → mode is 19', async () => {
  const timestamps = [
    ...timestampsAtHour(19, 8),
    ...timestampsAtHour(7, 3),
  ];
  const result = await peakHourCalculator(FAKE_USER_ID, {
    activityFetcher: async () => timestamps,
    tzOffsetMinutes: 330,
  });
  assert.strictEqual(result, 19);
});

// ── 9. Missing userId → throws ────────────────────────────────────────────────

test('peakHourCalculator: missing userId → throws', async () => {
  await assert.rejects(
    () => peakHourCalculator(null, { activityFetcher: async () => [] }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.toLowerCase().includes('userid'), `message: ${err.message}`);
      return true;
    },
  );
});

test('peakHourCalculator: undefined userId → throws', async () => {
  await assert.rejects(
    () => peakHourCalculator(undefined, { activityFetcher: async () => [] }),
    (err) => {
      assert.ok(err instanceof Error);
      return true;
    },
  );
});
