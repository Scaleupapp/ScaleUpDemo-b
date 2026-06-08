'use strict';

/**
 * Unit tests for the rejoin controller handler.
 *
 * Covers:
 *   1. Success: paused session → fresh pairing code returned
 *   2. Success: in_progress session → also returns fresh pairing code
 *   3. 409 NOT_RESUMABLE: graded session cannot be rejoined
 *   4. 404: session not found (wrong owner or nonexistent)
 *
 * The capstones controller has many heavy top-level requires (jsonwebtoken,
 * mongoose models, orchestrators, workers).  We stub ALL of them into
 * require.cache before loading the controller — same approach used by WS2
 * tests for pairingService and recordingService.  Each test restores the
 * originals (or evicts the cache entry) in a finally block.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal req/res pair for the handler under test. */
function makeReqRes({ sessionId = 'sess123', userId = 'user1' } = {}) {
  const req = {
    params: { session_id: sessionId },
    user: { userId },
  };
  let _status = 200;
  const body = {};
  const res = {
    status(code) { _status = code; return this; },
    json(data) { Object.assign(body, data); body._status = _status; return this; },
  };
  return { req, res, body };
}

/** Resolve all the paths the controller touches at the top level. */
function resolvePaths() {
  const r = (p) => require.resolve(p);
  return {
    controller: r('../../coding/controllers/capstones.controller'),
    jwt: r('jsonwebtoken'),
    CapstoneSession: r('../../coding/models/capstoneSession.model'),
    ArtifactBundle: r('../../coding/models/artifactBundle.model'),
    pairingService: r('../../coding/services/pairingService'),
    sandboxOrchestrator: r('../../coding/services/sandboxOrchestrator'),
    recordingService: r('../../coding/services/recordingService'),
    stateMachine: r('../../coding/services/sessionStateMachine'),
    sessionRoom: r('../../coding/websocket/sessionRoom'),
    capstoneEvalWorker: r('../../coding/workers/capstoneEval.worker'),
    snapshotService: r('../../coding/services/snapshotService'),
    capstoneSummary: r('../../coding/services/capstoneSummary'),
    planIntegration: r('../../coding/services/planIntegration'),
    CapstoneGenerationRequest: r('../../coding/models/capstoneGenerationRequest.model'),
    capstoneGenerationWorker: r('../../coding/workers/capstoneGeneration.worker'),
    DifficultyState: r('../../coding/models/difficultyState.model'),
    codingEligibility: r('../../coding/services/codingEligibility'),
  };
}

/**
 * Inject minimal stubs for every top-level dependency the controller needs,
 * load a fresh copy of the controller, run fn(handler), then restore.
 *
 * @param {object} opts
 * @param {object|null} opts.sessionDoc  - returned by CapstoneSession.findOne chain (null = not found)
 * @param {{ code: string, expiresAt: Date }} [opts.mintResult]
 * @param {Function} fn                  - async test body receiving the rejoin handler
 */
async function withRejoin({ sessionDoc, mintResult = { code: '654321', expiresAt: new Date() } }, fn) {
  const paths = resolvePaths();

  // Snapshot originals so we can restore
  const originals = {};
  for (const [key, p] of Object.entries(paths)) {
    originals[key] = require.cache[p];
  }

  function inject(p, exports) {
    require.cache[p] = { exports, loaded: true, id: p };
  }

  // --- Stubs ---
  inject(paths.jwt, { sign: () => 'stub-token', verify: () => ({}) });

  // CapstoneSession.findOne().select().lean() chain
  inject(paths.CapstoneSession, {
    findOne: () => ({ select: () => ({ lean: async () => sessionDoc }) }),
    exists: async () => null,
    find: async () => [],
    create: async () => ({}),
    countDocuments: async () => 0,
  });

  inject(paths.ArtifactBundle, {
    findById: () => ({ lean: async () => null }),
    find: async () => [],
  });

  inject(paths.pairingService, { mintCode: async () => mintResult });

  inject(paths.sandboxOrchestrator, {
    provisionForSession: async () => {},
    heartbeatExtend: async () => {},
    teardownForSession: async () => {},
    runInSession: async () => ({}),
    _adapter: { uploadFiles: async () => {} },
  });

  inject(paths.recordingService, {
    emit: () => {},
    finalize: async () => {},
    startRecording: async () => {},
  });

  inject(paths.stateMachine, {
    transition: async () => ({}),
    isAllowed: () => false,
    ALLOWED: {},
    InvalidTransitionError: class extends Error {},
  });

  inject(paths.sessionRoom, { publishLifecycle: () => {} });
  inject(paths.capstoneEvalWorker, { enqueueEvaluation: async () => {} });
  inject(paths.snapshotService, {
    captureForSession: async () => ({ captured: true }),
    loadSnapshot: async () => null,
  });
  inject(paths.capstoneSummary, { buildSummary: async () => ({}) });
  inject(paths.planIntegration, { getCapstoneMilestone: async () => null });

  inject(paths.CapstoneGenerationRequest, {
    create: async () => ({ _id: 'gr1' }),
    findOne: () => ({ lean: async () => null }),
    find: async () => [],
    findByIdAndUpdate: async () => {},
  });

  inject(paths.capstoneGenerationWorker, { enqueueGeneration: async () => {} });

  inject(paths.DifficultyState, {
    findOne: () => ({ lean: async () => null }),
  });

  inject(paths.codingEligibility, {
    evaluateCodingEligibility: () => ({ eligible: false }),
  });

  // Delete + reload controller with stubbed deps
  delete require.cache[paths.controller];

  try {
    const controller = require(paths.controller);
    await fn(controller.rejoin);
  } finally {
    // Restore originals (or evict if they weren't loaded before)
    for (const [key, p] of Object.entries(paths)) {
      if (originals[key]) {
        require.cache[p] = originals[key];
      } else {
        delete require.cache[p];
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('rejoin: paused session → 200 with session_id, pairing_code, expires_at', async () => {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await withRejoin(
    { sessionDoc: { _id: 'sess-paused', status: 'paused' }, mintResult: { code: '111222', expiresAt } },
    async (rejoin) => {
      const { req, res, body } = makeReqRes({ sessionId: 'sess-paused' });
      await rejoin(req, res);
      assert.equal(body._status, 200, 'expected HTTP 200');
      assert.equal(body.session_id, 'sess-paused');
      assert.equal(body.pairing_code, '111222');
      assert.equal(body.expires_at, expiresAt);
      // Must not leak internal session fields
      assert.equal(body.status, undefined, 'should not include session.status in response');
    }
  );
});

test('rejoin: in_progress session → also returns fresh pairing_code', async () => {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await withRejoin(
    { sessionDoc: { _id: 'sess-active', status: 'in_progress' }, mintResult: { code: '333444', expiresAt } },
    async (rejoin) => {
      const { req, res, body } = makeReqRes({ sessionId: 'sess-active' });
      await rejoin(req, res);
      assert.equal(body._status, 200);
      assert.equal(body.pairing_code, '333444');
    }
  );
});

test('rejoin: graded session → 409 NOT_RESUMABLE with current_status', async () => {
  await withRejoin(
    { sessionDoc: { _id: 'sess-graded', status: 'graded' } },
    async (rejoin) => {
      const { req, res, body } = makeReqRes({ sessionId: 'sess-graded' });
      await rejoin(req, res);
      assert.equal(body._status, 409, 'expected HTTP 409');
      assert.equal(body.error, 'NOT_RESUMABLE');
      assert.equal(body.current_status, 'graded');
    }
  );
});

test('rejoin: wrong owner / nonexistent session → 404 session_not_found', async () => {
  await withRejoin(
    { sessionDoc: null },
    async (rejoin) => {
      const { req, res, body } = makeReqRes({ sessionId: 'nonexistent' });
      await rejoin(req, res);
      assert.equal(body._status, 404, 'expected HTTP 404');
      assert.equal(body.error, 'session_not_found');
    }
  );
});
