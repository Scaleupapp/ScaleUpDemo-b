'use strict';

const { test } = require('node:test');
const assert = require('assert');

const {
  startRun,
  runAuthoring,
  getRunStatus,
  _helpers: { computeFlaggedIndices },
} = require('./authorAgentService');

// ── Fakes ────────────────────────────────────────────────────────────────

/** One decision row: { action, markModified(k), save() } — save/markModified are spied. */
function makeDecisionDoc(overrides = {}) {
  return {
    _id: 'dec1',
    institutionId: 'inst1',
    action: {
      kind: 'assessment_authoring_run',
      brief: 'brief',
      assessmentId: 'a1',
      runLog: [{ at: new Date(), msg: 'run queued' }],
      result: null,
    },
    markModified(key) {
      this.marked = (this.marked || []).concat(key);
    },
    async save() {
      this.saveCalls = (this.saveCalls || 0) + 1;
      // Assert-by-construction: every save must be preceded by markModified('action')
      // for THIS mutation. We just record ordering; tests assert on it directly.
      this.saveLog = (this.saveLog || []).concat({ markedBeforeThisSave: (this.marked || []).slice() });
    },
    ...overrides,
  };
}

/** Fake AgentDecision model backed by an in-memory map of decision docs. */
function makeAgentDecisionModel(store) {
  return {
    async create(payload) {
      const id = `dec${Object.keys(store).length + 1}`;
      const doc = makeDecisionDoc({ _id: id, institutionId: payload.institutionId, action: payload.action });
      store[id] = doc;
      return doc;
    },
    async findById(id) {
      return store[id] || null;
    },
  };
}

/** Fake Assessment model backed by an in-memory map. */
function makeAssessmentModel(store) {
  return {
    async findById(id) {
      return store[id] || null;
    },
  };
}

function passedQuestion({ ambiguous = false } = {}) {
  return { questionText: 'q', options: ['a', 'b', 'c', 'd'], correctAnswer: 'A', qa: { solver: { agrees: true, ambiguous } } };
}

function baseAssessment({ questions, authoringStatus = 'ready', status = 'draft', institutionId = 'inst1' }) {
  return {
    _id: 'a1',
    institutionId,
    status,
    type: 'mcq',
    config: {
      mcq: {
        questions,
        authoring: { status: authoringStatus, error: null, qaReport: { rounds: 1 } },
      },
    },
  };
}

// ── computeFlaggedIndices ────────────────────────────────────────────────

test('computeFlaggedIndices: flags only questions with qa.solver.ambiguous === true', () => {
  const assessment = baseAssessment({
    questions: [passedQuestion({ ambiguous: false }), passedQuestion({ ambiguous: true }), passedQuestion({})],
  });
  assert.deepStrictEqual(computeFlaggedIndices(assessment), [1]);
});

// ── runAuthoring: happy path ─────────────────────────────────────────────

test('runAuthoring: zero flagged questions -> ready, 1 pass, zero regenerated', async () => {
  const decisionStore = {};
  const AgentDecision = makeAgentDecisionModel(decisionStore);
  decisionStore.dec1 = makeDecisionDoc();

  const assessmentStore = { a1: baseAssessment({ questions: [passedQuestion(), passedQuestion()] }) };
  const Assessment = makeAssessmentModel(assessmentStore);

  let regenerateCalls = 0;
  const authoring = {
    authorMcq: async () => assessmentStore.a1,
    regenerateQuestion: async () => { regenerateCalls += 1; },
  };

  await runAuthoring({ decisionId: 'dec1', assessmentId: 'a1' }, { AgentDecision, Assessment, authoring });

  const result = decisionStore.dec1.action.result;
  assert.strictEqual(result.status, 'ready');
  assert.strictEqual(result.totalQuestions, 2);
  assert.strictEqual(result.regenerated, 0);
  assert.deepStrictEqual(result.flaggedIndices, []);
  assert.strictEqual(result.passes, 1);
  assert.strictEqual(regenerateCalls, 0);
});

// ── runAuthoring: repaired in pass 1 ─────────────────────────────────────

test('runAuthoring: flagged questions repaired in pass 1 -> ready, correct regenerated count', async () => {
  const decisionStore = { dec1: makeDecisionDoc() };
  const AgentDecision = makeAgentDecisionModel(decisionStore);

  const questions = [passedQuestion({ ambiguous: true }), passedQuestion({ ambiguous: false }), passedQuestion({ ambiguous: true })];
  const assessmentStore = { a1: baseAssessment({ questions }) };
  const Assessment = makeAssessmentModel(assessmentStore);

  let regenerateCalls = 0;
  const authoring = {
    authorMcq: async () => assessmentStore.a1,
    regenerateQuestion: async (assessmentId, idx) => {
      regenerateCalls += 1;
      // Simulate a successful repair: clear the ambiguous flag at idx.
      assessmentStore.a1.config.mcq.questions[idx] = passedQuestion({ ambiguous: false });
    },
  };

  await runAuthoring({ decisionId: 'dec1', assessmentId: 'a1' }, { AgentDecision, Assessment, authoring });

  const result = decisionStore.dec1.action.result;
  assert.strictEqual(result.status, 'ready');
  assert.strictEqual(result.regenerated, 2);
  assert.strictEqual(regenerateCalls, 2);
  assert.deepStrictEqual(result.flaggedIndices, []);
  assert.strictEqual(result.passes, 1);
});

// ── runAuthoring: persists past max passes ───────────────────────────────

test('runAuthoring: flagged questions persist past max passes -> needs_review with flaggedIndices', async () => {
  const prevMax = process.env.AUTHOR_AGENT_MAX_REPAIR_PASSES;
  process.env.AUTHOR_AGENT_MAX_REPAIR_PASSES = '2';
  try {
    const decisionStore = { dec1: makeDecisionDoc() };
    const AgentDecision = makeAgentDecisionModel(decisionStore);

    const questions = [passedQuestion({ ambiguous: true }), passedQuestion({ ambiguous: false })];
    const assessmentStore = { a1: baseAssessment({ questions }) };
    const Assessment = makeAssessmentModel(assessmentStore);

    let regenerateCalls = 0;
    const authoring = {
      authorMcq: async () => assessmentStore.a1,
      regenerateQuestion: async (assessmentId, idx) => {
        regenerateCalls += 1;
        // Simulate a stubborn item: regeneration keeps coming back ambiguous.
        assessmentStore.a1.config.mcq.questions[idx] = passedQuestion({ ambiguous: true });
      },
    };

    await runAuthoring({ decisionId: 'dec1', assessmentId: 'a1' }, { AgentDecision, Assessment, authoring });

    const result = decisionStore.dec1.action.result;
    assert.strictEqual(result.status, 'needs_review');
    assert.deepStrictEqual(result.flaggedIndices, [0]);
    assert.strictEqual(result.passes, 2);
    assert.strictEqual(regenerateCalls, 2); // one regen attempt per pass for index 0
  } finally {
    if (prevMax === undefined) delete process.env.AUTHOR_AGENT_MAX_REPAIR_PASSES;
    else process.env.AUTHOR_AGENT_MAX_REPAIR_PASSES = prevMax;
  }
});

// ── runAuthoring: authorMcq throws ───────────────────────────────────────

test('runAuthoring: authorMcq throws -> failed result + log entry, never throws', async () => {
  const decisionStore = { dec1: makeDecisionDoc() };
  const AgentDecision = makeAgentDecisionModel(decisionStore);
  const Assessment = makeAssessmentModel({});

  const authoring = {
    authorMcq: async () => { throw new Error('generateQuiz blew up'); },
    regenerateQuestion: async () => { throw new Error('should not be called'); },
  };

  await assert.doesNotReject(runAuthoring({ decisionId: 'dec1', assessmentId: 'a1' }, { AgentDecision, Assessment, authoring }));

  const doc = decisionStore.dec1;
  const result = doc.action.result;
  assert.strictEqual(result.status, 'failed');
  assert.ok(doc.action.runLog.some((e) => /authoring failed: generateQuiz blew up/.test(e.msg)));
});

// ── runAuthoring: authoring settles but never reaches 'ready' ───────────

test('runAuthoring: authorMcq resolves but authoring status stays failed -> result failed', async () => {
  const decisionStore = { dec1: makeDecisionDoc() };
  const AgentDecision = makeAgentDecisionModel(decisionStore);

  const assessmentStore = {
    a1: baseAssessment({ questions: [], authoringStatus: 'failed' }),
  };
  assessmentStore.a1.config.mcq.authoring.error = 'QA produced only 3/10 passing questions';
  const Assessment = makeAssessmentModel(assessmentStore);

  const authoring = {
    authorMcq: async () => assessmentStore.a1,
    regenerateQuestion: async () => { throw new Error('should not be called'); },
  };

  await runAuthoring({ decisionId: 'dec1', assessmentId: 'a1' }, { AgentDecision, Assessment, authoring });

  const result = decisionStore.dec1.action.result;
  assert.strictEqual(result.status, 'failed');
});

// ── runAuthoring: markModified called before every save ─────────────────

test('runAuthoring: markModified("action") is called before every save on the decision row', async () => {
  const decisionStore = { dec1: makeDecisionDoc() };
  const AgentDecision = makeAgentDecisionModel(decisionStore);

  const assessmentStore = { a1: baseAssessment({ questions: [passedQuestion()] }) };
  const Assessment = makeAssessmentModel(assessmentStore);

  const authoring = {
    authorMcq: async () => assessmentStore.a1,
    regenerateQuestion: async () => {},
  };

  await runAuthoring({ decisionId: 'dec1', assessmentId: 'a1' }, { AgentDecision, Assessment, authoring });

  const doc = decisionStore.dec1;
  assert.ok(doc.saveCalls > 0, 'save should have been called at least once');
  // Every recorded save must have had 'action' already in the marked list at that point.
  for (const entry of doc.saveLog) {
    assert.ok(entry.markedBeforeThisSave.includes('action'), 'markModified("action") must precede every save');
  }
});

// ── startRun: guards ──────────────────────────────────────────────────

function startRunDeps({ agentEnabled = true, assessment, record } = {}) {
  const assessmentStore = assessment ? { a1: assessment } : {};
  return {
    isAgentEnabled: () => agentEnabled,
    Assessment: makeAssessmentModel(assessmentStore),
    AgentDecision: makeAgentDecisionModel({}),
    authoring: { authorMcq: async () => assessmentStore.a1, regenerateQuestion: async () => {} },
    record: record || (async (payload) => ({ _id: 'dec1', action: payload.action })),
  };
}

test('startRun: agent disabled -> throws /disabled/', async () => {
  const deps = startRunDeps({ agentEnabled: false, assessment: baseAssessment({ questions: [] }) });
  await assert.rejects(
    startRun({ assessmentId: 'a1', institutionId: 'inst1' }, deps),
    /disabled/
  );
});

test('startRun: wrong institution -> throws /not found/', async () => {
  const deps = startRunDeps({ assessment: baseAssessment({ questions: [], institutionId: 'inst-other' }) });
  await assert.rejects(
    startRun({ assessmentId: 'a1', institutionId: 'inst1' }, deps),
    /not found/
  );
});

test('startRun: assessment missing entirely -> throws /not found/', async () => {
  const deps = startRunDeps({ assessment: undefined });
  await assert.rejects(
    startRun({ assessmentId: 'a1', institutionId: 'inst1' }, deps),
    /not found/
  );
});

test('startRun: released assessment -> throws /not authorable/', async () => {
  const deps = startRunDeps({ assessment: baseAssessment({ questions: [], status: 'released' }) });
  await assert.rejects(
    startRun({ assessmentId: 'a1', institutionId: 'inst1' }, deps),
    /not authorable/
  );
});

test('startRun: mcq authoring already generating -> throws /not authorable/', async () => {
  const deps = startRunDeps({ assessment: baseAssessment({ questions: [], authoringStatus: 'generating', status: 'configured' }) });
  await assert.rejects(
    startRun({ assessmentId: 'a1', institutionId: 'inst1' }, deps),
    /not authorable/
  );
});

test('startRun: happy path records decision and returns decisionId', async () => {
  const assessment = baseAssessment({ questions: [passedQuestion()], status: 'configured' });
  let recordedPayload = null;
  const deps = startRunDeps({
    assessment,
    record: async (payload) => {
      recordedPayload = payload;
      return { _id: 'dec-new', action: payload.action };
    },
  });

  const { decisionId } = await startRun(
    { assessmentId: 'a1', institutionId: 'inst1', cohortId: 'cohort1', actorInstitutionUserId: 'iu1', brief: 'author 10 mcqs' },
    deps
  );

  assert.strictEqual(decisionId, 'dec-new');
  assert.strictEqual(recordedPayload.agentId, 'author_agent');
  assert.strictEqual(recordedPayload.decisionType, 'artifact');
  assert.strictEqual(recordedPayload.userId, undefined);
  assert.strictEqual(recordedPayload.action.kind, 'assessment_authoring_run');
  assert.strictEqual(recordedPayload.action.assessmentId, 'a1');
  assert.strictEqual(recordedPayload.action.result, null);
  assert.strictEqual(recordedPayload.promptVersion, 'author-agent-v1');
  assert.ok(Array.isArray(recordedPayload.action.runLog) && recordedPayload.action.runLog.length === 1);
});

// ── getRunStatus ──────────────────────────────────────────────────────

test('getRunStatus: returns generating status when result is still null', async () => {
  const decisionStore = { dec1: makeDecisionDoc() };
  const AgentDecision = makeAgentDecisionModel(decisionStore);

  const { status, runLog, result } = await getRunStatus({ decisionId: 'dec1', institutionId: 'inst1' }, { AgentDecision });
  assert.strictEqual(status, 'generating');
  assert.strictEqual(result, null);
  assert.ok(Array.isArray(runLog));
});

test('getRunStatus: returns persisted result status once finalized', async () => {
  const decisionStore = { dec1: makeDecisionDoc() };
  decisionStore.dec1.action.result = { status: 'ready', totalQuestions: 5, regenerated: 0, flaggedIndices: [], passes: 1 };
  const AgentDecision = makeAgentDecisionModel(decisionStore);

  const { status } = await getRunStatus({ decisionId: 'dec1', institutionId: 'inst1' }, { AgentDecision });
  assert.strictEqual(status, 'ready');
});

test('getRunStatus: wrong institution -> throws /not found/', async () => {
  const decisionStore = { dec1: makeDecisionDoc() };
  const AgentDecision = makeAgentDecisionModel(decisionStore);

  await assert.rejects(
    getRunStatus({ decisionId: 'dec1', institutionId: 'inst-other' }, { AgentDecision }),
    /not found/
  );
});

test('getRunStatus: unknown decisionId -> throws /not found/', async () => {
  const AgentDecision = makeAgentDecisionModel({});
  await assert.rejects(
    getRunStatus({ decisionId: 'nope', institutionId: 'inst1' }, { AgentDecision }),
    /not found/
  );
});
