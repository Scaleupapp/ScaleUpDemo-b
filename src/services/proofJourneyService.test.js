'use strict';

const { test } = require('node:test');
const assert = require('assert');

const {
  startJourney,
  advanceOnCapstoneGraded,
  publishProof,
  getJourney,
  _helpers,
} = require('./proofJourneyService');

// ── Fakes ────────────────────────────────────────────────────────────────

const USER = 'user-1';

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function matchesJourney(doc, filter) {
  return Object.keys(filter).every((k) => String(getPath(doc, k)) === String(filter[k]));
}

/** Chainable fake supporting .sort() / .lean() / direct-await, matching the
 * three call shapes proofJourneyService uses against ProofJourney.findOne. */
function makeJourneyQuery(list) {
  return {
    sort: (spec) => {
      const key = Object.keys(spec)[0];
      const dir = spec[key];
      const sorted = [...list].sort((a, b) => {
        const av = a[key] instanceof Date ? a[key].getTime() : a[key];
        const bv = b[key] instanceof Date ? b[key].getTime() : b[key];
        return dir === -1 ? bv - av : av - bv;
      });
      return makeJourneyQuery(sorted);
    },
    lean: async () => (list.length ? list[0] : null),
    then: (...args) => Promise.resolve(list.length ? list[0] : null).then(...args),
    catch: (...args) => Promise.resolve(list.length ? list[0] : null).catch(...args),
  };
}

function makeJourneyModel(store) {
  return {
    findOne: (filter) => makeJourneyQuery(store.filter((doc) => matchesJourney(doc, filter))),
    create: async (payload) => {
      const doc = {
        _id: payload._id || `journey-${store.length + 1}`,
        userId: payload.userId,
        jdText: payload.jdText,
        jdSummary: payload.jdSummary || {},
        status: payload.status || 'extracting',
        capstoneRef: payload.capstoneRef || {},
        proofToken: payload.proofToken || null,
        steps: payload.steps ? payload.steps.map((s) => ({ ...s })) : [],
        nextProofSuggestion: payload.nextProofSuggestion || null,
        ledgerDecisionId: undefined,
        createdAt: payload.createdAt || new Date(),
      };
      doc.save = async function () { this._saveCount = (this._saveCount || 0) + 1; };
      store.push(doc);
      return doc;
    },
  };
}

function journeyFixture(overrides = {}) {
  const doc = {
    _id: 'journey-1',
    userId: USER,
    jdText: 'we need a backend engineer who knows React and SQL',
    jdSummary: { role: 'Backend Engineer', company: 'Acme', skills: ['React', 'SQL', 'System design'] },
    status: 'building',
    capstoneRef: { bundleId: null, sessionId: null },
    proofToken: null,
    steps: _helpers.seedSteps(),
    nextProofSuggestion: null,
    ledgerDecisionId: undefined,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  };
  doc.save = async function () { this._saveCount = (this._saveCount || 0) + 1; };
  return doc;
}

/** Ledger rows are stored separately (mirrors AgentDecision) so findById +
 * mutate + markModified + save can be exercised faithfully. */
function makeLedgerHarness() {
  const store = [];
  const recorded = [];
  const record = async (payload) => {
    recorded.push(payload);
    const row = {
      _id: `ledger-${store.length + 1}`,
      ...payload,
      status: 'pending',
      outcomeSignal: null,
      respondedAt: null,
    };
    row.save = async function () { this._saveCount = (this._saveCount || 0) + 1; };
    row.markModified = function (field) {
      this._markModified = this._markModified || [];
      this._markModified.push(field);
    };
    store.push(row);
    return row;
  };
  const AgentDecision = { findById: async (id) => store.find((r) => String(r._id) === String(id)) || null };
  return { store, recorded, record, AgentDecision };
}

function fakeAiProvider({ result, shouldThrow } = {}) {
  return {
    analyzeWithClaude: async () => {
      if (shouldThrow) throw new Error('analyzeWithClaude: response contained no JSON object');
      return result;
    },
  };
}

function fakeRequestGeneration({ shouldThrow } = {}) {
  const calls = [];
  const fn = async (params) => {
    calls.push(params);
    if (shouldThrow) throw new Error('queue unavailable');
    return { _id: 'genreq-1', status: 'queued', ...params };
  };
  fn.calls = calls;
  return fn;
}

function fakeProofService({ snapshot, throwOnSnapshot, publishResult } = {}) {
  return {
    buildSnapshot: async () => {
      if (throwOnSnapshot) throw new Error('NO_OBJECTIVE');
      return snapshot;
    },
    publish: async () => publishResult || { token: 'tok-1', url: 'https://scaleup-web/r/tok-1', shareText: 'proof' },
  };
}

/** Fake CapstoneSession — findById(id).lean() shape, matching how the
 * service queries it. `sessions` is a plain array of {_id, bundle_id,
 * user_id} rows. */
function makeCapstoneSessionModel(sessions) {
  return {
    findById: (id) => ({
      lean: async () => sessions.find((s) => String(s._id) === String(id)) || null,
    }),
  };
}

/** Fake CapstoneGenerationRequest — findOne(filter).lean() shape. `rows` is
 * a plain array of {_id, bundle_id} rows. */
function makeCapstoneGenerationRequestModel(rows) {
  return {
    findOne: (filter) => ({
      lean: async () => rows.find((r) => String(r.bundle_id) === String(filter.bundle_id)) || null,
    }),
  };
}

function baseDeps(overrides = {}) {
  const ledger = overrides.__ledger || makeLedgerHarness();
  return {
    isAgentEnabled: () => true,
    now: () => new Date('2026-07-12T00:00:00.000Z'),
    _awaitBackground: true, // deterministic tests — never set in production
    record: ledger.record,
    AgentDecision: ledger.AgentDecision,
    resolveRoleTrackForUser: async () => 'swe',
    requestGeneration: fakeRequestGeneration(),
    aiProvider: fakeAiProvider({ result: { role: 'Backend Engineer', company: 'Acme', skills: ['React', 'SQL'] } }),
    proofService: fakeProofService({ snapshot: { competencies: [] } }),
    CapstoneSession: makeCapstoneSessionModel([]),
    CapstoneGenerationRequest: makeCapstoneGenerationRequestModel([]),
    ...overrides,
  };
}

// ── startJourney — state machine + ledger timing ───────────────────────────

test('startJourney: flag off -> null, zero writes', async () => {
  const store = [];
  const deps = baseDeps({ isAgentEnabled: () => false, ProofJourney: makeJourneyModel(store) });
  const result = await startJourney({ userId: USER, jdText: 'some jd' }, deps);
  assert.strictEqual(result, null);
  assert.strictEqual(store.length, 0);
});

test('startJourney: missing jdText throws synchronously (caller bug, not hook safety)', async () => {
  const store = [];
  const deps = baseDeps({ ProofJourney: makeJourneyModel(store) });
  await assert.rejects(() => startJourney({ userId: USER, jdText: '  ' }, deps), /jdText is required/);
  assert.strictEqual(store.length, 0);
});

test('startJourney: creates row (extracting, seeded steps) and records proof_journey ledger row before background work', async () => {
  const store = [];
  const ledger = makeLedgerHarness();
  const deps = baseDeps({ __ledger: ledger, ProofJourney: makeJourneyModel(store), _awaitBackground: false });
  const journey = await startJourney({ userId: USER, jdText: 'JD text here' }, deps);

  assert.strictEqual(journey.status, 'extracting');
  assert.strictEqual(journey.steps.length, 5);
  assert.strictEqual(journey.steps[0].key, 'extract');
  assert.strictEqual(journey.steps[0].status, 'now');
  assert.ok(journey.steps.slice(1).every((s) => s.status === 'todo'));

  // Ledger row recorded synchronously, before any background extraction ran.
  assert.strictEqual(ledger.recorded.length, 1);
  assert.strictEqual(ledger.recorded[0].agentId, 'proof_builder');
  assert.strictEqual(ledger.recorded[0].decisionType, 'artifact');
  assert.strictEqual(ledger.recorded[0].action.kind, 'proof_journey');
  assert.strictEqual(ledger.recorded[0].action.jdChars, 'JD text here'.length);
  assert.strictEqual(ledger.recorded[0].promptVersion, 'proof-builder-v1');
  assert.strictEqual(journey.ledgerDecisionId, 'ledger-1');
});

test('startJourney: extraction failure -> status failed, extract step failed, never throws to caller, no generation call', async () => {
  const store = [];
  const genGen = fakeRequestGeneration();
  const deps = baseDeps({
    ProofJourney: makeJourneyModel(store),
    aiProvider: fakeAiProvider({ shouldThrow: true }),
    requestGeneration: genGen,
  });
  const journey = await startJourney({ userId: USER, jdText: 'JD text' }, deps);
  assert.strictEqual(journey.status, 'failed');
  const extractStep = journey.steps.find((s) => s.key === 'extract');
  assert.strictEqual(extractStep.status, 'failed');
  assert.strictEqual(genGen.calls.length, 0); // generation never kicked off
});

test('startJourney: extraction success + generation kickoff success -> capstone_pending then building, jdSummary set', async () => {
  const store = [];
  const genGen = fakeRequestGeneration();
  const deps = baseDeps({ ProofJourney: makeJourneyModel(store), requestGeneration: genGen });
  const journey = await startJourney({ userId: USER, jdText: 'JD text' }, deps);

  assert.strictEqual(journey.status, 'building');
  assert.deepStrictEqual(journey.jdSummary, { role: 'Backend Engineer', company: 'Acme', skills: ['React', 'SQL'] });
  assert.strictEqual(journey.steps.find((s) => s.key === 'extract').status, 'done');
  assert.strictEqual(journey.steps.find((s) => s.key === 'generate').status, 'done');
  assert.strictEqual(journey.steps.find((s) => s.key === 'build').status, 'now');
  assert.strictEqual(genGen.calls.length, 1);
  assert.strictEqual(genGen.calls[0].jobDescription, 'JD text');
  assert.strictEqual(genGen.calls[0].roleTrack, 'swe');
  assert.strictEqual(genGen.calls[0].language, 'javascript');
  assert.strictEqual(genGen.calls[0].difficulty, _helpers.DEFAULT_DIFFICULTY);
  // Correlation-closure (Task 4 EXPANDED): generationRequestId is stamped
  // the moment kickCapstoneGeneration resolves, well before bundleId/
  // sessionId ever exist.
  assert.strictEqual(journey.capstoneRef.generationRequestId, 'genreq-1');
});

test('startJourney: generation kickoff failure (e.g. no resolvable coding track) -> failed, generate step failed', async () => {
  const store = [];
  const deps = baseDeps({
    ProofJourney: makeJourneyModel(store),
    resolveRoleTrackForUser: async () => null,
  });
  const journey = await startJourney({ userId: USER, jdText: 'JD text' }, deps);
  assert.strictEqual(journey.status, 'failed');
  assert.strictEqual(journey.steps.find((s) => s.key === 'generate').status, 'failed');
  // extraction itself still succeeded and is recorded before the failure.
  assert.strictEqual(journey.steps.find((s) => s.key === 'extract').status, 'done');
});

test('startJourney: enqueue failure from the existing generation entry point also -> failed', async () => {
  const store = [];
  const deps = baseDeps({
    ProofJourney: makeJourneyModel(store),
    requestGeneration: fakeRequestGeneration({ shouldThrow: true }),
  });
  const journey = await startJourney({ userId: USER, jdText: 'JD text' }, deps);
  assert.strictEqual(journey.status, 'failed');
  assert.strictEqual(journey.steps.find((s) => s.key === 'generate').status, 'failed');
});

// ── advanceOnCapstoneGraded — correlation chain + heuristic + ledger timing ─
//
// Task 4 EXPANDED: the hook resolves sessionId -> bundle_id (CapstoneSession)
// -> journey, either via a direct capstoneRef.bundleId match or (fallback,
// the FIRST-grade path for every journey) via the CapstoneGenerationRequest
// that produced the bundle -> capstoneRef.generationRequestId match.

test('advanceOnCapstoneGraded: flag off -> {advanced:false}, zero writes', async () => {
  const store = [journeyFixture({ capstoneRef: { bundleId: 'b1', sessionId: null } })];
  const deps = baseDeps({
    isAgentEnabled: () => false,
    ProofJourney: makeJourneyModel(store),
    CapstoneSession: makeCapstoneSessionModel([{ _id: 'sess-1', bundle_id: 'b1', user_id: USER }]),
  });
  const result = await advanceOnCapstoneGraded({ userId: USER, sessionId: 'sess-1' }, deps);
  assert.deepStrictEqual(result, { advanced: false });
  assert.strictEqual(store[0].status, 'building');
});

test('advanceOnCapstoneGraded: session not found -> no-op, never throws', async () => {
  const store = [journeyFixture({ capstoneRef: { bundleId: 'b1', sessionId: null } })];
  const deps = baseDeps({
    ProofJourney: makeJourneyModel(store),
    CapstoneSession: makeCapstoneSessionModel([]), // no such session
  });
  const result = await advanceOnCapstoneGraded({ userId: USER, sessionId: 'sess-999' }, deps);
  assert.deepStrictEqual(result, { advanced: false });
  assert.strictEqual(store[0].status, 'building');
});

test('advanceOnCapstoneGraded: no-match anywhere (bundle not correlated to any journey, no genReq) -> no-op', async () => {
  const store = [journeyFixture({ capstoneRef: { bundleId: 'b-other', sessionId: null } })];
  const deps = baseDeps({
    ProofJourney: makeJourneyModel(store),
    CapstoneSession: makeCapstoneSessionModel([{ _id: 'sess-1', bundle_id: 'b1', user_id: USER }]),
    CapstoneGenerationRequest: makeCapstoneGenerationRequestModel([]), // no genReq for b1 either
  });
  const result = await advanceOnCapstoneGraded({ userId: USER, sessionId: 'sess-1' }, deps);
  assert.deepStrictEqual(result, { advanced: false });
  assert.strictEqual(store[0].status, 'building');
});

test('advanceOnCapstoneGraded: wrong user -> no-op (journey belongs to a different userId)', async () => {
  const store = [journeyFixture({
    userId: 'someone-else',
    capstoneRef: { bundleId: 'b1', sessionId: null },
  })];
  const deps = baseDeps({
    ProofJourney: makeJourneyModel(store),
    CapstoneSession: makeCapstoneSessionModel([{ _id: 'sess-1', bundle_id: 'b1', user_id: 'someone-else' }]),
  });
  const result = await advanceOnCapstoneGraded({ userId: USER, sessionId: 'sess-1' }, deps);
  assert.deepStrictEqual(result, { advanced: false });
  assert.strictEqual(store[0].status, 'building');
});

test('advanceOnCapstoneGraded: direct bundleId match -> publishable, grade/build done, publish now, nextProofSuggestion computed, ledger outcomeSignal updated', async () => {
  const ledger = makeLedgerHarness();
  const ledgerRow = await ledger.record({ agentId: 'proof_builder', decisionType: 'artifact', userId: USER, action: { kind: 'proof_journey' } });
  const store = [journeyFixture({
    capstoneRef: { bundleId: 'b1', sessionId: null },
    jdSummary: { role: 'Backend Engineer', company: 'Acme', skills: ['React', 'SQL'] },
    ledgerDecisionId: ledgerRow._id,
  })];
  const deps = baseDeps({
    __ledger: ledger,
    ProofJourney: makeJourneyModel(store),
    CapstoneSession: makeCapstoneSessionModel([{ _id: 'sess-1', bundle_id: 'b1', user_id: USER }]),
    proofService: fakeProofService({ snapshot: { competencies: [{ name: 'React', score: 80, assessed: true }] } }),
  });

  const result = await advanceOnCapstoneGraded({ userId: USER, sessionId: 'sess-1' }, deps);
  assert.strictEqual(result.advanced, true);
  assert.strictEqual(store[0].status, 'publishable');
  assert.strictEqual(store[0].steps.find((s) => s.key === 'build').status, 'done');
  assert.strictEqual(store[0].steps.find((s) => s.key === 'grade').status, 'done');
  assert.strictEqual(store[0].steps.find((s) => s.key === 'publish').status, 'now');
  // capstoneRef.sessionId is stamped even though the match was via bundleId.
  assert.strictEqual(store[0].capstoneRef.sessionId, 'sess-1');
  // React is evidenced (competency match) -> SQL is the gap -> the suggestion.
  assert.strictEqual(store[0].nextProofSuggestion.skill, 'SQL');

  const closedRow = ledger.store.find((r) => r._id === ledgerRow._id);
  assert.deepStrictEqual(closedRow.outcomeSignal, { graded: true });
  assert.ok(closedRow._markModified.includes('outcomeSignal'));
  assert.strictEqual(closedRow._saveCount, 1);
});

test('advanceOnCapstoneGraded: full-chain match via CapstoneGenerationRequest fallback (bundleId not yet stamped on any journey)', async () => {
  const store = [journeyFixture({
    capstoneRef: { bundleId: null, sessionId: null, generationRequestId: 'genreq-1' },
    jdSummary: { role: 'Backend Engineer', company: 'Acme', skills: ['React', 'SQL'] },
  })];
  const deps = baseDeps({
    ProofJourney: makeJourneyModel(store),
    CapstoneSession: makeCapstoneSessionModel([{ _id: 'sess-1', bundle_id: 'b1', user_id: USER }]),
    CapstoneGenerationRequest: makeCapstoneGenerationRequestModel([{ _id: 'genreq-1', bundle_id: 'b1' }]),
  });

  const result = await advanceOnCapstoneGraded({ userId: USER, sessionId: 'sess-1' }, deps);
  assert.strictEqual(result.advanced, true);
  assert.strictEqual(store[0].status, 'publishable');
  // Correlation closed: bundleId/sessionId are now stamped for future lookups.
  assert.strictEqual(store[0].capstoneRef.bundleId, 'b1');
  assert.strictEqual(store[0].capstoneRef.sessionId, 'sess-1');
});

test('advanceOnCapstoneGraded: idempotent — already publishable -> no-op, no duplicate ledger mutation', async () => {
  const ledger = makeLedgerHarness();
  const ledgerRow = await ledger.record({ agentId: 'proof_builder', decisionType: 'artifact', userId: USER, action: {} });
  const store = [journeyFixture({
    status: 'publishable',
    capstoneRef: { bundleId: 'b1', sessionId: 'sess-1' },
    ledgerDecisionId: ledgerRow._id,
  })];
  const deps = baseDeps({
    __ledger: ledger,
    ProofJourney: makeJourneyModel(store),
    CapstoneSession: makeCapstoneSessionModel([{ _id: 'sess-1', bundle_id: 'b1', user_id: USER }]),
  });
  const result = await advanceOnCapstoneGraded({ userId: USER, sessionId: 'sess-1' }, deps);
  assert.deepStrictEqual(result, { advanced: false });
  assert.strictEqual(ledger.store.find((r) => r._id === ledgerRow._id).outcomeSignal, null);
});

// ── nextProofSuggestion heuristic — pure ────────────────────────────────────

test('heuristic: first non-evidenced JD skill (priority order) is the suggestion', async () => {
  const d = {
    proofService: fakeProofService({ snapshot: { competencies: [{ name: 'React', score: 90, assessed: true }] } }),
  };
  const result = await _helpers.computeNextProofSuggestion(
    { userId: USER, jdSummary: { skills: ['React', 'SQL', 'System design'] } }, d,
  );
  assert.strictEqual(result.skill, 'SQL');
});

test('heuristic: all JD skills evidenced -> falls back to weakest overlapping competency score', async () => {
  const d = {
    proofService: fakeProofService({
      snapshot: {
        competencies: [
          { name: 'React', score: 90, assessed: true },
          { name: 'SQL', score: 55, assessed: true },
        ],
      },
    }),
  };
  const result = await _helpers.computeNextProofSuggestion(
    { userId: USER, jdSummary: { skills: ['React', 'SQL'] } }, d,
  );
  assert.strictEqual(result.skill, 'SQL');
  assert.match(result.reason, /weakest score \(55\)/);
});

test('heuristic: no readiness snapshot yet -> first JD skill, honest reason, never throws', async () => {
  const d = { proofService: fakeProofService({ throwOnSnapshot: true }) };
  const result = await _helpers.computeNextProofSuggestion(
    { userId: USER, jdSummary: { skills: ['React', 'SQL'] } }, d,
  );
  assert.strictEqual(result.skill, 'React');
  assert.match(result.reason, /No readiness evidence yet/);
});

test('heuristic: no JD skills -> null', async () => {
  const result = await _helpers.computeNextProofSuggestion({ userId: USER, jdSummary: { skills: [] } }, {});
  assert.strictEqual(result, null);
});

// ── publishProof — guard + success + ledger acceptance ─────────────────────

test('publishProof: flag off -> null, zero writes', async () => {
  const store = [journeyFixture({ status: 'publishable' })];
  const deps = baseDeps({ isAgentEnabled: () => false, ProofJourney: makeJourneyModel(store) });
  const result = await publishProof({ userId: USER }, deps);
  assert.strictEqual(result, null);
  assert.strictEqual(store[0].status, 'publishable');
});

test('publishProof: no journey -> throws', async () => {
  const deps = baseDeps({ ProofJourney: makeJourneyModel([]) });
  await assert.rejects(() => publishProof({ userId: USER }, deps), /no proof journey found/);
});

test('publishProof: guard — status not publishable -> throws, proofService.publish never called', async () => {
  const store = [journeyFixture({ status: 'building' })];
  let publishCalled = false;
  const deps = baseDeps({
    ProofJourney: makeJourneyModel(store),
    proofService: { publish: async () => { publishCalled = true; return { token: 't' }; } },
  });
  await assert.rejects(() => publishProof({ userId: USER }, deps), /not publishable yet/);
  assert.strictEqual(publishCalled, false);
});

test('publishProof: success — publishes via proofService, stores token, status published, publish step done, ledger closed accepted', async () => {
  const ledger = makeLedgerHarness();
  const ledgerRow = await ledger.record({ agentId: 'proof_builder', decisionType: 'artifact', userId: USER, action: {} });
  const store = [journeyFixture({ status: 'publishable', ledgerDecisionId: ledgerRow._id })];
  const deps = baseDeps({
    __ledger: ledger,
    ProofJourney: makeJourneyModel(store),
    proofService: fakeProofService({ publishResult: { token: 'tok-xyz', url: 'https://x/r/tok-xyz', shareText: 'proof' } }),
  });

  const journey = await publishProof({ userId: USER }, deps);
  assert.strictEqual(journey.status, 'published');
  assert.strictEqual(journey.proofToken, 'tok-xyz');
  assert.strictEqual(journey.steps.find((s) => s.key === 'publish').status, 'done');

  const closedRow = ledger.store.find((r) => r._id === ledgerRow._id);
  assert.strictEqual(closedRow.status, 'accepted');
  assert.ok(closedRow.respondedAt);
});

// ── getJourney — client shape ────────────────────────────────────────────

test('getJourney: flag off -> null', async () => {
  const deps = baseDeps({ isAgentEnabled: () => false, ProofJourney: makeJourneyModel([journeyFixture()]) });
  assert.strictEqual(await getJourney({ userId: USER }, deps), null);
});

test('getJourney: no journey -> null', async () => {
  const deps = baseDeps({ ProofJourney: makeJourneyModel([]) });
  assert.strictEqual(await getJourney({ userId: USER }, deps), null);
});

test('getJourney: shapes the latest journey with steps checklist', async () => {
  const store = [journeyFixture({ status: 'publishable', nextProofSuggestion: { skill: 'SQL', reason: 'gap' } })];
  const deps = baseDeps({ ProofJourney: makeJourneyModel(store) });
  const result = await getJourney({ userId: USER }, deps);
  assert.strictEqual(result.status, 'publishable');
  assert.strictEqual(result.steps.length, 5);
  assert.deepStrictEqual(result.nextProofSuggestion, { skill: 'SQL', reason: 'gap' });
  assert.deepStrictEqual(result.jdSummary.skills, ['React', 'SQL', 'System design']);
});
