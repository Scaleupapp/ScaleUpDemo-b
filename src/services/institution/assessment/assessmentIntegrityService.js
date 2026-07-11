'use strict';
/**
 * assessmentIntegrityService.js — Wave 3 block 4.
 *
 * Pure helpers for honest integrity accounting and per-engine score framing.
 * No model requires; everything operates on already-fetched plain objects so it
 * is trivially unit-testable and shared by the rollup, monitor, CSV and at-risk
 * paths.
 *
 * Integrity truth: a session is only "checked" (proctored) when there is a REAL
 * signal behind it — capstone runs on a paired device (integrity_confidence), or
 * the app has POSTed take-flow counters. mcq / drill ('unverified') / interview
 * (transcript-guess) carry NO real signal today, so they are reported as
 * "not proctored" rather than "0 flags". flaggedCount derives ONLY from real
 * flags — never fabricated.
 */

// mcq is objectively keyed; every other engine is graded by an LLM.
function scoreMethodForEngine(engineType) {
  return engineType === 'mcq' ? 'objective' : 'ai_judged';
}

// Values (from either the capstone engine or client signals) that count as a flag.
const REAL_FLAG_VALUES = ['low', 'suspicious', 'minor_flags'];

// Does this session carry client-reported take-flow signals?
function hasClientSignals(session) {
  const sig = session && session.integritySignals;
  if (!sig) return false;
  return sig.updatedAt != null
    || sig.pasteCount != null
    || sig.appBackgroundedCount != null
    || sig.focusLossSeconds != null;
}

// Capstone is the only engine with a genuine proctoring signal today.
function hasEngineSignal(session) {
  const engineType = session && session.engine && session.engine.type;
  return engineType === 'capstone' && session.result && session.result.integrity != null;
}

/**
 * Classify one session: is it proctored (a real signal exists), and is that
 * signal a flag? Sessions with no real signal are neither — they are unproctored.
 */
function classifySessionIntegrity(session) {
  const client = hasClientSignals(session);
  const engine = hasEngineSignal(session);
  if (!client && !engine) return { proctored: false, flagged: false };

  let flagged = false;
  if (client && session.integritySignals.flagged) flagged = true;
  if (engine && REAL_FLAG_VALUES.includes(session.result.integrity)) flagged = true;
  return { proctored: true, flagged };
}

/**
 * Summarize integrity across sessions (typically the STARTED sessions of a
 * cohort/assessment). Returns honest, non-overlapping counts.
 *   checkedCount     — sessions with a real signal
 *   flaggedCount     — of those, the ones actually flagged (== the old integrityFlags)
 *   unproctoredCount — sessions with no real signal (mcq/drill/interview today)
 */
function summarizeIntegrity(sessions) {
  let checkedCount = 0;
  let flaggedCount = 0;
  let unproctoredCount = 0;
  for (const s of sessions || []) {
    const { proctored, flagged } = classifySessionIntegrity(s);
    if (proctored) {
      checkedCount += 1;
      if (flagged) flaggedCount += 1;
    } else {
      unproctoredCount += 1;
    }
  }
  return { checkedCount, flaggedCount, unproctoredCount };
}

// The distinct engine's score method for a set of sessions, or 'mixed' when a
// cohort-wide rollup spans multiple engines (never cross-average those).
function scoreMethodForSessions(sessions) {
  const types = new Set();
  for (const s of sessions || []) {
    const t = s.engine && s.engine.type;
    if (t) types.add(t);
  }
  if (types.size === 0) return undefined;
  if (types.size === 1) return scoreMethodForEngine([...types][0]);
  return 'mixed';
}

// ── Client take-flow signal ingestion (Wave 3 block 4) ───────────────────────

const SIGNAL_BOUNDS = {
  appBackgroundedCount: 10000,
  focusLossSeconds: 86400, // 24h
  pasteCount: 10000,
};

// Coerce + clamp a counter into [0, max]. Returns null for a non-finite value so
// the caller can reject it (validation), vs clamping out-of-range numbers.
function clampCounter(val, max) {
  if (val === undefined || val === null) return 0;
  const n = Number(val);
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(Math.floor(n), 0), max);
}

// Conservative flag rule: any paste, or more than 3 app-backgroundings.
function signalsAreFlagged({ appBackgroundedCount = 0, pasteCount = 0 }) {
  return pasteCount > 0 || appBackgroundedCount > 3;
}

/**
 * Validate + clamp a raw ingestion body into a storable signals object.
 * @returns {{ ok: true, signals } | { ok: false, code }}
 */
function buildIngestedSignals(body, now) {
  const appBackgroundedCount = clampCounter(body && body.appBackgroundedCount, SIGNAL_BOUNDS.appBackgroundedCount);
  const focusLossSeconds = clampCounter(body && body.focusLossSeconds, SIGNAL_BOUNDS.focusLossSeconds);
  const pasteCount = clampCounter(body && body.pasteCount, SIGNAL_BOUNDS.pasteCount);
  if (appBackgroundedCount === null || focusLossSeconds === null || pasteCount === null) {
    return { ok: false, code: 'VALIDATION' };
  }
  const flagged = signalsAreFlagged({ appBackgroundedCount, pasteCount });
  return {
    ok: true,
    signals: { appBackgroundedCount, focusLossSeconds, pasteCount, flagged, updatedAt: now || new Date() },
  };
}

module.exports = {
  scoreMethodForEngine,
  scoreMethodForSessions,
  classifySessionIntegrity,
  summarizeIntegrity,
  buildIngestedSignals,
  signalsAreFlagged,
  clampCounter,
  SIGNAL_BOUNDS,
  REAL_FLAG_VALUES,
};
