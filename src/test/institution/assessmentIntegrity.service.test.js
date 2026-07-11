'use strict';
const test = require('node:test');
const assert = require('node:assert');
const svc = require('../../services/institution/assessment/assessmentIntegrityService');

// ── scoreMethodForEngine ─────────────────────────────────────────────────────
test('scoreMethodForEngine: mcq=objective, others=ai_judged', () => {
  assert.strictEqual(svc.scoreMethodForEngine('mcq'), 'objective');
  assert.strictEqual(svc.scoreMethodForEngine('interview'), 'ai_judged');
  assert.strictEqual(svc.scoreMethodForEngine('capstone'), 'ai_judged');
  assert.strictEqual(svc.scoreMethodForEngine('drill'), 'ai_judged');
});

test('scoreMethodForSessions: single engine → that method, mixed → mixed', () => {
  assert.strictEqual(svc.scoreMethodForSessions([{ engine: { type: 'mcq' } }]), 'objective');
  assert.strictEqual(svc.scoreMethodForSessions([{ engine: { type: 'capstone' } }, { engine: { type: 'capstone' } }]), 'ai_judged');
  assert.strictEqual(svc.scoreMethodForSessions([{ engine: { type: 'mcq' } }, { engine: { type: 'interview' } }]), 'mixed');
  assert.strictEqual(svc.scoreMethodForSessions([]), undefined);
});

// ── summarizeIntegrity ───────────────────────────────────────────────────────
test('summarizeIntegrity: capstone proctored, mcq/interview/drill unproctored', () => {
  const sessions = [
    { engine: { type: 'capstone' }, result: { integrity: 'low' } },   // proctored + flagged
    { engine: { type: 'capstone' }, result: { integrity: 'high' } },  // proctored, clean
    { engine: { type: 'mcq' }, result: { integrity: 'suspicious' } }, // NO real signal → unproctored
    { engine: { type: 'interview' }, result: { integrity: 'low' } },  // transcript-guess → unproctored
    { engine: { type: 'drill' }, result: { integrity: 'unverified' } }, // unproctored
  ];
  const out = svc.summarizeIntegrity(sessions);
  assert.strictEqual(out.checkedCount, 2);
  assert.strictEqual(out.flaggedCount, 1);
  assert.strictEqual(out.unproctoredCount, 3);
});

test('summarizeIntegrity: client-ingested signals make any engine proctored + flagged', () => {
  const sessions = [
    { engine: { type: 'mcq' }, integritySignals: { pasteCount: 2, flagged: true, updatedAt: new Date() } },
    { engine: { type: 'mcq' }, integritySignals: { pasteCount: 0, appBackgroundedCount: 1, flagged: false, updatedAt: new Date() } },
    { engine: { type: 'mcq' } }, // no signals → unproctored
  ];
  const out = svc.summarizeIntegrity(sessions);
  assert.strictEqual(out.checkedCount, 2);
  assert.strictEqual(out.flaggedCount, 1);
  assert.strictEqual(out.unproctoredCount, 1);
});

// ── buildIngestedSignals (validate/clamp) ────────────────────────────────────
test('buildIngestedSignals: clamps to bounds and floors', () => {
  const now = new Date();
  const out = svc.buildIngestedSignals({ appBackgroundedCount: 2.9, focusLossSeconds: 999999, pasteCount: -3 }, now);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.signals.appBackgroundedCount, 2, 'floored');
  assert.strictEqual(out.signals.focusLossSeconds, svc.SIGNAL_BOUNDS.focusLossSeconds, 'clamped to max');
  assert.strictEqual(out.signals.pasteCount, 0, 'negative clamped to 0');
  assert.strictEqual(out.signals.flagged, false, '2 backgroundings, no paste → clean');
});

test('buildIngestedSignals: >3 backgroundings flags', () => {
  const out = svc.buildIngestedSignals({ appBackgroundedCount: 4 }, new Date());
  assert.strictEqual(out.signals.flagged, true);
});

test('buildIngestedSignals: missing fields default to 0, unflagged', () => {
  const out = svc.buildIngestedSignals({}, new Date());
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(
    { a: out.signals.appBackgroundedCount, f: out.signals.focusLossSeconds, p: out.signals.pasteCount, flagged: out.signals.flagged },
    { a: 0, f: 0, p: 0, flagged: false },
  );
});

test('buildIngestedSignals: non-numeric → not ok (VALIDATION)', () => {
  const out = svc.buildIngestedSignals({ pasteCount: 'x' }, new Date());
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, 'VALIDATION');
});
