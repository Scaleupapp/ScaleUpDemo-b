'use strict';
/**
 * Workstream B — institution assessment notifications.
 *
 * Covers: the assessment_assigned (release) + assessment_results (close/worker)
 * notify helpers, the notify-once atomic guard, the env-flag gate
 * (PLACEMENTS_NOTIFICATIONS_ENABLED, default OFF), and the worker wiring.
 * All deps injected — no DB, no real notificationService.
 */
const test = require('node:test');
const assert = require('node:assert');
const svc = require('../../services/institution/assessment/assessmentService');
const { runSyncTick } = require('../../workers/assessmentSync.worker');

const FLAG = 'PLACEMENTS_NOTIFICATIONS_ENABLED';

// Run `fn` with the flag forced on/off, always restoring the prior value.
async function withFlag(value, fn) {
  const prev = process.env[FLAG];
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
  try { return await fn(); }
  finally {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  }
}

function enrollmentStub(userIds) {
  return {
    find: (q) => ({ _q: q, select: async () => userIds.map((id) => ({ userId: id })) }),
  };
}

function notifierStub() {
  const sent = [];
  return { sent, notificationService: { sendToUsers: async (ids, payload) => { sent.push({ ids, payload }); return []; } } };
}

// ── _notifyAssessmentAssigned (release) ───────────────────────────────────────

test('assessment_assigned: OFF by default → no notification, no recipient lookup', async () => {
  await withFlag(undefined, async () => {
    let lookedUp = false;
    const deps = {
      InstitutionEnrollment: { find: () => { lookedUp = true; return { select: async () => [] }; } },
      notificationService: { sendToUsers: async () => { throw new Error('should not send'); } },
    };
    const r = await svc._notifyAssessmentAssigned({ _id: 'a1', title: 'T', cohortId: 'c1' }, deps);
    assert.deepStrictEqual(r, { notified: false, reason: 'disabled' });
    assert.strictEqual(lookedUp, false, 'must not even query recipients while gated off');
  });
});

test('assessment_assigned: ON → notifies non-withdrawn cohort with correct copy + data', async () => {
  await withFlag('true', async () => {
    const { sent, notificationService } = notifierStub();
    const deps = { InstitutionEnrollment: enrollmentStub(['u1', 'u2']), notificationService };
    const a = { _id: 'a1', title: 'Aptitude Round', cohortId: 'c1', closesAt: new Date('2026-08-20T00:00:00Z') };
    const r = await svc._notifyAssessmentAssigned(a, deps);
    assert.deepStrictEqual(r, { notified: true, count: 2 });
    assert.strictEqual(sent.length, 1);
    assert.deepStrictEqual(sent[0].ids, ['u1', 'u2']);
    assert.strictEqual(sent[0].payload.title, 'New assessment: Aptitude Round');
    assert.match(sent[0].payload.body, /^Aptitude Round is now open — closes .+\.$/);
    assert.strictEqual(sent[0].payload.data.type, 'assessment_assigned');
    assert.strictEqual(sent[0].payload.data.assessmentId, 'a1');
  });
});

test('assessment_assigned: ON but no recipients → no send', async () => {
  await withFlag('true', async () => {
    const { sent, notificationService } = notifierStub();
    const deps = { InstitutionEnrollment: enrollmentStub([]), notificationService };
    const r = await svc._notifyAssessmentAssigned({ _id: 'a1', title: 'T', cohortId: 'c1' }, deps);
    assert.deepStrictEqual(r, { notified: false, reason: 'no_recipients' });
    assert.strictEqual(sent.length, 0);
  });
});

test('assessment_assigned: ON with no closesAt → body omits the closes clause', async () => {
  await withFlag('true', async () => {
    const { sent, notificationService } = notifierStub();
    const deps = { InstitutionEnrollment: enrollmentStub(['u1']), notificationService };
    await svc._notifyAssessmentAssigned({ _id: 'a1', title: 'Quiz', cohortId: 'c1', closesAt: null }, deps);
    assert.strictEqual(sent[0].payload.body, 'Quiz is now open.');
  });
});

test('assessment_assigned: a send error is swallowed (best-effort)', async () => {
  await withFlag('true', async () => {
    const deps = {
      InstitutionEnrollment: enrollmentStub(['u1']),
      notificationService: { sendToUsers: async () => { throw new Error('fcm down'); } },
    };
    const r = await svc._notifyAssessmentAssigned({ _id: 'a1', title: 'T', cohortId: 'c1' }, deps);
    assert.deepStrictEqual(r, { notified: false, reason: 'error' });
  });
});

// ── _notifyAssessmentResults (close / worker) + atomic guard ──────────────────

test('assessment_results: OFF by default → no guard write, no send', async () => {
  await withFlag(undefined, async () => {
    let guardCalled = false;
    const deps = {
      Assessment: { findOneAndUpdate: async () => { guardCalled = true; return {}; } },
      InstitutionEnrollment: enrollmentStub(['u1']),
      notificationService: { sendToUsers: async () => { throw new Error('should not send'); } },
    };
    const r = await svc._notifyAssessmentResults({ _id: 'a1', title: 'T', cohortId: 'c1' }, deps);
    assert.deepStrictEqual(r, { notified: false, reason: 'disabled' });
    assert.strictEqual(guardCalled, false, 'must NOT set resultsNotifiedAt while gated off');
  });
});

test('assessment_results: ON → winner of the atomic guard notifies once', async () => {
  await withFlag('true', async () => {
    const { sent, notificationService } = notifierStub();
    let guardFilter = null;
    const a = { _id: 'a1', title: 'Mock Interview', cohortId: 'c1' };
    const deps = {
      Assessment: {
        findOneAndUpdate: async (filter, update) => { guardFilter = { filter, update }; return a; }, // won
      },
      InstitutionEnrollment: enrollmentStub(['u1', 'u2', 'u3']),
      notificationService,
    };
    const r = await svc._notifyAssessmentResults(a, deps);
    assert.deepStrictEqual(r, { notified: true, count: 3 });
    assert.strictEqual(sent[0].payload.title, 'Results are out');
    assert.strictEqual(sent[0].payload.body, 'Your Mock Interview results are ready to review.');
    assert.strictEqual(sent[0].payload.data.type, 'assessment_results');
    // Guard targets a null/absent resultsNotifiedAt and sets it.
    assert.ok(guardFilter.update.$set.resultsNotifiedAt instanceof Date);
    assert.ok(guardFilter.filter.$or, 'guard filters on resultsNotifiedAt null/absent');
  });
});

test('assessment_results: ON but guard lost (already notified) → no send', async () => {
  await withFlag('true', async () => {
    const { sent, notificationService } = notifierStub();
    const deps = {
      Assessment: { findOneAndUpdate: async () => null }, // someone else already won
      InstitutionEnrollment: enrollmentStub(['u1']),
      notificationService,
    };
    const r = await svc._notifyAssessmentResults({ _id: 'a1', title: 'T', cohortId: 'c1' }, deps);
    assert.deepStrictEqual(r, { notified: false, reason: 'already_notified' });
    assert.strictEqual(sent.length, 0, 'notify-once: loser must not send');
  });
});

// ── releaseAssessment integration ─────────────────────────────────────────────

function releasableDoc() {
  return {
    _id: 'a1', type: 'mcq', status: 'configured', cohortId: 'c1', title: 'Round 1',
    config: { mcq: { questions: [{ questionText: 'Q' }] } },
    closesAt: new Date('2026-09-01T00:00:00Z'),
    save: async function () { return this; },
  };
}

test('releaseAssessment: ON → releases AND notifies the cohort (assigned)', async () => {
  await withFlag('true', async () => {
    const { sent, notificationService } = notifierStub();
    const deps = {
      Assessment: { findOne: async () => releasableDoc() },
      InstitutionEnrollment: enrollmentStub(['u1']),
      notificationService,
    };
    const res = await svc.releaseAssessment({ institutionId: 'i1' }, 'a1', 'tpo1', deps);
    assert.strictEqual(res.status, 'released');
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].payload.data.type, 'assessment_assigned');
  });
});

test('releaseAssessment: OFF → releases with NO notification (default-safe)', async () => {
  await withFlag(undefined, async () => {
    let sendCalled = false;
    const deps = {
      Assessment: { findOne: async () => releasableDoc() },
      InstitutionEnrollment: enrollmentStub(['u1']),
      notificationService: { sendToUsers: async () => { sendCalled = true; return []; } },
    };
    const res = await svc.releaseAssessment({ institutionId: 'i1' }, 'a1', 'tpo1', deps);
    assert.strictEqual(res.status, 'released');
    assert.strictEqual(sendCalled, false);
  });
});

// ── closeAssessment integration ───────────────────────────────────────────────

test('closeAssessment: ON → closes AND notifies results once via the guard', async () => {
  await withFlag('true', async () => {
    const { sent, notificationService } = notifierStub();
    const doc = { _id: 'a1', status: 'released', cohortId: 'c1', title: 'Finals', closesAt: null, save: async function () { return this; } };
    const deps = {
      Assessment: { findOne: async () => doc, findOneAndUpdate: async () => doc },
      InstitutionEnrollment: enrollmentStub(['u1', 'u2']),
      notificationService,
      now: () => new Date('2026-09-10T00:00:00Z'),
    };
    const res = await svc.closeAssessment({ institutionId: 'i1' }, 'a1', 'tpo1', deps);
    assert.strictEqual(res.status, 'closed');
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].payload.data.type, 'assessment_results');
  });
});

// ── worker wiring ─────────────────────────────────────────────────────────────

test('runSyncTick: calls results-notify with the closed assessment (once)', async () => {
  const pastClose = new Date(Date.now() - 1000);
  const session = { _id: 's1', assessmentId: 'a1', status: 'in_progress', save: async function () { return this; } };
  const assessment = { _id: 'a1', cohortId: 'c1', title: 'Quiz', closesAt: pastClose };
  const calls = [];
  const deps = {
    AssessmentSession: { find: async () => [session], findById: async () => ({ ...session, status: 'in_progress' }) },
    Assessment: { findById: async () => assessment },
    syncSession: async () => {},
    now: () => new Date(),
    notifyAssessmentResults: async (a) => { calls.push(String(a._id)); },
  };
  await runSyncTick(deps);
  assert.deepStrictEqual(calls, ['a1']);
});

test('runSyncTick: does NOT notify results while the window is still open', async () => {
  const futureClose = new Date(Date.now() + 86_400_000);
  const session = { _id: 's1', assessmentId: 'a1', status: 'in_progress', save: async function () { return this; } };
  const calls = [];
  const deps = {
    AssessmentSession: { find: async () => [session] },
    Assessment: { findById: async () => ({ _id: 'a1', cohortId: 'c1', title: 'Q', closesAt: futureClose }) },
    syncSession: async () => {},
    now: () => new Date(),
    notifyAssessmentResults: async (a) => { calls.push(String(a._id)); },
  };
  await runSyncTick(deps);
  assert.deepStrictEqual(calls, [], 'no results notify before the window closes');
});

test('runSyncTick: a results-notify throw does not break the tick', async () => {
  const pastClose = new Date(Date.now() - 1000);
  const session = { _id: 's1', assessmentId: 'a1', status: 'in_progress', save: async function () { return this; } };
  let synced = false;
  const deps = {
    AssessmentSession: { find: async () => [session], findById: async () => ({ ...session, status: 'graded' }) },
    Assessment: { findById: async () => ({ _id: 'a1', cohortId: 'c1', title: 'Q', closesAt: pastClose }) },
    syncSession: async () => { synced = true; },
    now: () => new Date(),
    notifyAssessmentResults: async () => { throw new Error('notify boom'); },
  };
  await assert.doesNotReject(() => runSyncTick(deps));
  assert.strictEqual(synced, true, 'final-sync still runs after a notify throw');
});
