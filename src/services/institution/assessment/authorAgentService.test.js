'use strict';

const { test } = require('node:test');
const assert = require('assert');

const {
  startRun,
  runAuthoring,
  getRunStatus,
  reapOrphanedRuns,
  createAndAuthor,
  listRuns,
  _helpers: { computeFlaggedIndices, buildObjectiveContext, humanizeAuthoringFailure, describeAuthoringFailure, runPreflight },
} = require('./authorAgentService');

/** Dot-path get/set — the reaper's Assessment.updateOne fake needs both. */
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}
function setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  keys.slice(0, -1).forEach((k) => {
    cur[k] = cur[k] || {};
    cur = cur[k];
  });
  cur[keys[keys.length - 1]] = value;
}

// ── Fakes ────────────────────────────────────────────────────────────────

/** One decision row: { action, markModified(k), save() } — save/markModified are spied. */
function makeDecisionDoc(overrides = {}) {
  return {
    _id: 'dec1',
    institutionId: 'inst1',
    createdAt: new Date(),
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

/** Matches a stored decision doc against a Mongo-shaped query (dot-path fields only). */
function matchesDecisionQuery(row, query) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === 'agentId') return row.agentId === expected;
    if (key === 'action.assessmentId') return !!row.action && row.action.assessmentId === expected;
    if (key === 'action.result') {
      // Mongo's `{ field: null }` matches both an explicit null and a missing field.
      if (expected === null) return !row.action || row.action.result === null || row.action.result === undefined;
      return !!row.action && row.action.result === expected;
    }
    if (key === 'createdAt' && expected && typeof expected === 'object' && '$lt' in expected) {
      return new Date(row.createdAt).getTime() < new Date(expected.$lt).getTime();
    }
    return row[key] === expected;
  });
}

/** Fake AgentDecision model backed by an in-memory map of decision docs. */
function makeAgentDecisionModel(store) {
  return {
    async create(payload) {
      const id = `dec${Object.keys(store).length + 1}`;
      const doc = makeDecisionDoc({
        _id: id,
        agentId: payload.agentId,
        institutionId: payload.institutionId,
        action: payload.action,
      });
      store[id] = doc;
      return doc;
    },
    async findById(id) {
      return store[id] || null;
    },
    // Chainable to mirror the real Mongoose builder (`.findOne(...).select(...).lean()`)
    // used by startRun's in-flight guard.
    findOne(query = {}) {
      const found = Object.values(store).find((row) => matchesDecisionQuery(row, query)) || null;
      const q = {
        select: () => q,
        lean: async () => found,
        then: (resolve, reject) => Promise.resolve(found).then(resolve, reject),
      };
      return q;
    },
    // Chainable to mirror `.find(query).exec()`, used by reapOrphanedRuns.
    find(query = {}) {
      const matched = Object.values(store).filter((row) => matchesDecisionQuery(row, query));
      const q = {
        exec: async () => matched,
        then: (resolve, reject) => Promise.resolve(matched).then(resolve, reject),
      };
      return q;
    },
  };
}

/** Fake Assessment model backed by an in-memory map. */
function makeAssessmentModel(store) {
  return {
    async findById(id) {
      return store[id] || null;
    },
    // Scoped update mirroring Assessment.updateOne({_id, <dot-path>: cond}, {$set: {...}})
    // used by reapOrphanedRuns to reset a stuck config.<engine>.authoring.status.
    async updateOne(query, update) {
      const doc = store[query._id];
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      const matches = Object.entries(query).every(([key, expected]) => {
        if (key === '_id') return true;
        return getPath(doc, key) === expected;
      });
      if (!matches) return { matchedCount: 1, modifiedCount: 0 };
      if (update && update.$set) {
        Object.entries(update.$set).forEach(([path, value]) => setPath(doc, path, value));
      }
      return { matchedCount: 1, modifiedCount: 1 };
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
  // Raw code retained for debugging even though the log line is human-facing.
  assert.strictEqual(result.evidence.errorCode, 'generateQuiz blew up');
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

// ── startRun: uniform agent-level in-flight guard (all four engines) ────

test('startRun: rejects when a prior author_agent run for this assessment is unfinished (action.result null), no new ledger row recorded', async () => {
  const decisionStore = {};
  const AgentDecision = makeAgentDecisionModel(decisionStore);
  // Simulate a prior in-flight run's ledger row directly — the row is only
  // finalized (action.result set) when the run ends.
  await AgentDecision.create({
    agentId: 'author_agent',
    institutionId: 'inst1',
    action: { kind: 'assessment_authoring_run', assessmentId: 'a1', engine: 'mcq', runLog: [], result: null },
  });
  const rowCountBefore = Object.keys(decisionStore).length;

  const assessment = baseAssessment({ questions: [], status: 'configured' });
  const deps = {
    isAgentEnabled: () => true,
    Assessment: makeAssessmentModel({ a1: assessment }),
    AgentDecision,
    record: async () => { throw new Error('record should not be called when a run is already in flight'); },
  };

  await assert.rejects(
    startRun({ assessmentId: 'a1', institutionId: 'inst1', brief: 'second click' }, deps),
    /already in progress/
  );
  assert.strictEqual(Object.keys(decisionStore).length, rowCountBefore, 'no new ledger row should be recorded');
});

test('startRun: succeeds when the prior author_agent run for this assessment IS finalized (result non-null)', async () => {
  const decisionStore = {};
  const AgentDecision = makeAgentDecisionModel(decisionStore);
  await AgentDecision.create({
    agentId: 'author_agent',
    institutionId: 'inst1',
    action: {
      kind: 'assessment_authoring_run',
      assessmentId: 'a1',
      engine: 'mcq',
      runLog: [],
      result: { status: 'ready', engine: 'mcq', evidence: {}, flagged: [], passes: 1 },
    },
  });

  const assessment = baseAssessment({ questions: [passedQuestion()], status: 'configured' });
  let recorded = null;
  const deps = {
    isAgentEnabled: () => true,
    Assessment: makeAssessmentModel({ a1: assessment }),
    AgentDecision,
    authoring: { authorMcq: async () => assessment, regenerateQuestion: async () => {} },
    record: async (payload) => { recorded = payload; return { _id: 'dec-new', action: payload.action }; },
  };

  const { decisionId } = await startRun({ assessmentId: 'a1', institutionId: 'inst1', brief: 'new run' }, deps);
  assert.strictEqual(decisionId, 'dec-new');
  assert.ok(recorded, 'record should be called once the prior run is finalized');
});

test('startRun: in-flight guard applies to capstone (the engine that motivated it)', async () => {
  const decisionStore = {};
  const AgentDecision = makeAgentDecisionModel(decisionStore);
  await AgentDecision.create({
    agentId: 'author_agent',
    institutionId: 'inst1',
    action: { kind: 'assessment_authoring_run', assessmentId: 'a1', engine: 'capstone', runLog: [], result: null },
  });
  const rowCountBefore = Object.keys(decisionStore).length;

  const assessment = bundleAssessment({ type: 'capstone', bundleId: null, status: 'draft' });
  const deps = {
    isAgentEnabled: () => true,
    Assessment: makeAssessmentModel({ a1: assessment }),
    AgentDecision,
    ArtifactBundle: makeArtifactBundleModel({}),
    record: async () => { throw new Error('record should not be called when a run is already in flight'); },
  };

  await assert.rejects(
    startRun({ assessmentId: 'a1', institutionId: 'inst1', brief: 'double-clicked capstone run' }, deps),
    /already in progress/
  );
  assert.strictEqual(Object.keys(decisionStore).length, rowCountBefore, 'no new ledger row should be recorded');
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

// ── startRun: createdByAgent is written atomically into the record() payload ──
// (never patched onto the row after the fact — see authorAgentService.js's
// startRun/createAndAuthor doc comments for why a post-hoc save would race
// runAuthoring's fire-and-forget mutations of the same row.)

test('startRun: without createdByAgent, the record() payload carries no createdByAgent key at all', async () => {
  const assessment = baseAssessment({ questions: [passedQuestion()], status: 'configured' });
  let recordedPayload = null;
  const deps = startRunDeps({
    assessment,
    record: async (payload) => {
      recordedPayload = payload;
      return { _id: 'dec-new', action: payload.action };
    },
  });

  await startRun({ assessmentId: 'a1', institutionId: 'inst1', brief: 'hand-configured run' }, deps);

  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(recordedPayload.action, 'createdByAgent'),
    false,
    'existing callers that never pass createdByAgent must see byte-identical action shape'
  );
});

test('startRun: createdByAgent: true -> record() payload carries action.createdByAgent === true', async () => {
  const assessment = baseAssessment({ questions: [passedQuestion()], status: 'configured' });
  let recordedPayload = null;
  const deps = startRunDeps({
    assessment,
    record: async (payload) => {
      recordedPayload = payload;
      return { _id: 'dec-new', action: payload.action };
    },
  });

  await startRun(
    { assessmentId: 'a1', institutionId: 'inst1', brief: 'one-prompt create', createdByAgent: true },
    deps
  );

  assert.strictEqual(recordedPayload.action.createdByAgent, true);
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

// ── engine-aware helpers ─────────────────────────────────────────────────

function bundleDoc({ status = 'active', role_track = 'swe', difficulty = 'medium', language = 'python', drill_subtype, human_reviewed = false } = {}) {
  return {
    _id: 'bundle1',
    status,
    role_track,
    difficulty,
    language,
    drill_subtype,
    generated_by: { human_reviewed },
  };
}

function makeArtifactBundleModel(store) {
  return {
    async findById(id) {
      return store[id] || null;
    },
  };
}

function interviewAssessment({ authoringStatus = 'ready', questionPlan, error = null, status = 'draft', institutionId = 'inst1' } = {}) {
  return {
    _id: 'a1',
    institutionId,
    status,
    type: 'interview',
    config: {
      interview: {
        authoring: { status: authoringStatus, error, questionPlan: questionPlan || null },
      },
    },
  };
}

function bundleAssessment({ type, bundleId, status = 'draft', institutionId = 'inst1', title = 'Backend Engineer Capstone', configExtra = {} } = {}) {
  return {
    _id: 'a1',
    institutionId,
    status,
    type,
    title,
    config: {
      [type]: { bundleId, ...configExtra },
    },
  };
}

// ── runAuthoring: interview engine ──────────────────────────────────────

test('runAuthoring: interview ready -> surfaces real judge/lint/rounds evidence from questionPlan', async () => {
  const decisionStore = { dec1: makeDecisionDoc() };
  const AgentDecision = makeAgentDecisionModel(decisionStore);

  const questionPlan = {
    questions: [{ question: 'q1', outline: 'o1' }, { question: 'q2', outline: 'o2' }],
    judge: { verdict: 'accept', scores: { relevance: 5, difficultyHonesty: 4, coverage: 4, realism: 5 }, valid: true, notes: '' },
    lint: { passed: true, failures: [] },
    rounds: 1,
  };
  const assessmentStore = { a1: interviewAssessment({ questionPlan }) };
  const Assessment = makeAssessmentModel(assessmentStore);

  const authoring = { authorInterview: async () => assessmentStore.a1 };

  await runAuthoring({ decisionId: 'dec1', assessmentId: 'a1' }, { AgentDecision, Assessment, authoring });

  const result = decisionStore.dec1.action.result;
  assert.strictEqual(result.status, 'ready');
  assert.strictEqual(result.engine, 'interview');
  assert.deepStrictEqual(result.flagged, []);
  assert.strictEqual(result.passes, 0);
  assert.strictEqual(result.evidence.questionCount, 2);
  assert.strictEqual(result.evidence.rounds, 1);
  assert.strictEqual(result.evidence.judgeVerdict, 'accept');
  assert.deepStrictEqual(result.evidence.judgeScores, { relevance: 5, difficultyHonesty: 4, coverage: 4, realism: 5 });
  assert.strictEqual(result.evidence.lintPassed, true);
});

test('runAuthoring: interview authoring persisted status "failed" -> result failed, error in log', async () => {
  const decisionStore = { dec1: makeDecisionDoc() };
  const AgentDecision = makeAgentDecisionModel(decisionStore);

  const assessmentStore = { a1: interviewAssessment({ authoringStatus: 'failed', error: 'judge rejected: judge_low_realism' }) };
  const Assessment = makeAssessmentModel(assessmentStore);

  const authoring = { authorInterview: async () => assessmentStore.a1 };

  await runAuthoring({ decisionId: 'dec1', assessmentId: 'a1' }, { AgentDecision, Assessment, authoring });

  const doc = decisionStore.dec1;
  assert.strictEqual(doc.action.result.status, 'failed');
  assert.strictEqual(doc.action.result.engine, 'interview');
  assert.ok(doc.action.runLog.some((e) => /authoring gate failed: judge rejected: judge_low_realism/.test(e.msg)));
});

test('runAuthoring: interview authorInterview throws -> failed result, never throws', async () => {
  const decisionStore = { dec1: makeDecisionDoc() };
  const AgentDecision = makeAgentDecisionModel(decisionStore);
  const Assessment = makeAssessmentModel({ a1: interviewAssessment() });

  const authoring = { authorInterview: async () => { throw new Error('planService blew up'); } };

  await assert.doesNotReject(runAuthoring({ decisionId: 'dec1', assessmentId: 'a1' }, { AgentDecision, Assessment, authoring }));
  const doc = decisionStore.dec1;
  assert.strictEqual(doc.action.result.status, 'failed');
  assert.ok(doc.action.runLog.some((e) => /authoring failed: planService blew up/.test(e.msg)));
});

// ── runAuthoring: capstone engine ───────────────────────────────────────

test('runAuthoring: capstone bundle active -> ready, evidence from real ArtifactBundle fields', async () => {
  const decisionStore = { dec1: makeDecisionDoc() };
  const AgentDecision = makeAgentDecisionModel(decisionStore);

  const assessmentStore = { a1: bundleAssessment({ type: 'capstone', bundleId: 'bundle1' }) };
  const Assessment = makeAssessmentModel(assessmentStore);
  const bundleStore = { bundle1: bundleDoc({ status: 'active', role_track: 'swe', difficulty: 'medium', language: 'python', human_reviewed: true }) };
  const ArtifactBundle = makeArtifactBundleModel(bundleStore);

  const authoring = { authorCapstone: async () => assessmentStore.a1 };

  await runAuthoring({ decisionId: 'dec1', assessmentId: 'a1' }, { AgentDecision, Assessment, ArtifactBundle, authoring });

  const result = decisionStore.dec1.action.result;
  assert.strictEqual(result.status, 'ready');
  assert.strictEqual(result.engine, 'capstone');
  assert.strictEqual(result.passes, 0);
  assert.deepStrictEqual(result.flagged, []);
  assert.strictEqual(result.evidence.bundleId, 'bundle1');
  assert.strictEqual(result.evidence.bundleStatus, 'active');
  assert.strictEqual(result.evidence.roleTrack, 'swe');
  assert.strictEqual(result.evidence.difficulty, 'medium');
  assert.strictEqual(result.evidence.language, 'python');
  assert.strictEqual(result.evidence.humanReviewed, true);
});

test('runAuthoring: capstone bundle validated (not promoted) -> needs_review', async () => {
  const decisionStore = { dec1: makeDecisionDoc() };
  const AgentDecision = makeAgentDecisionModel(decisionStore);

  const assessmentStore = { a1: bundleAssessment({ type: 'capstone', bundleId: 'bundle1' }) };
  const Assessment = makeAssessmentModel(assessmentStore);
  const bundleStore = { bundle1: bundleDoc({ status: 'validated' }) };
  const ArtifactBundle = makeArtifactBundleModel(bundleStore);

  const authoring = { authorCapstone: async () => assessmentStore.a1 };

  await runAuthoring({ decisionId: 'dec1', assessmentId: 'a1' }, { AgentDecision, Assessment, ArtifactBundle, authoring });

  const result = decisionStore.dec1.action.result;
  assert.strictEqual(result.status, 'needs_review');
  assert.strictEqual(result.evidence.bundleStatus, 'validated');
});

test('runAuthoring: capstone authorCapstone throws -> failed result, never throws', async () => {
  const decisionStore = { dec1: makeDecisionDoc() };
  const AgentDecision = makeAgentDecisionModel(decisionStore);
  const assessmentStore = { a1: bundleAssessment({ type: 'capstone', bundleId: null }) };
  const Assessment = makeAssessmentModel(assessmentStore);
  const ArtifactBundle = makeArtifactBundleModel({});

  const authoring = { authorCapstone: async () => { throw new Error('CAPSTONE_GEN_FAILED'); } };

  await assert.doesNotReject(runAuthoring({ decisionId: 'dec1', assessmentId: 'a1' }, { AgentDecision, Assessment, ArtifactBundle, authoring }));
  const result = decisionStore.dec1.action.result;
  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.engine, 'capstone');
  // Raw code retained for debugging...
  assert.strictEqual(result.evidence.errorCode, 'CAPSTONE_GEN_FAILED');
  // ...but the TPO-facing run log shows a human sentence, not the bare code.
  const doc = decisionStore.dec1;
  assert.ok(
    doc.action.runLog.some((e) => /failed its own quality checks/.test(e.msg)),
    `expected a human sentence in the run log, got: ${JSON.stringify(doc.action.runLog)}`,
  );
  assert.ok(
    !doc.action.runLog.some((e) => /^authoring failed: CAPSTONE_GEN_FAILED$/.test(e.msg)),
    'run log must not show the bare engine code',
  );
});

test('runAuthoring: capstone authorCapstone throws with a real underlying reason (.detail) -> surfaced in run log', async () => {
  const decisionStore = { dec1: makeDecisionDoc() };
  const AgentDecision = makeAgentDecisionModel(decisionStore);
  const assessmentStore = { a1: bundleAssessment({ type: 'capstone', bundleId: null }) };
  const Assessment = makeAssessmentModel(assessmentStore);
  const ArtifactBundle = makeArtifactBundleModel({});

  const authoring = {
    authorCapstone: async () => {
      const err = new Error('CAPSTONE_GEN_FAILED');
      err.detail = 'seeded_mistakes_fail: seeded_mistake location "src/wallet.js — debit balance check" does not reference any bundle file';
      throw err;
    },
  };

  await runAuthoring({ decisionId: 'dec1', assessmentId: 'a1' }, { AgentDecision, Assessment, ArtifactBundle, authoring });
  const doc = decisionStore.dec1;
  assert.strictEqual(doc.action.result.evidence.errorCode, 'CAPSTONE_GEN_FAILED');
  assert.ok(
    doc.action.runLog.some((e) => e.msg.includes('failed its own quality checks') && e.msg.includes('seeded_mistake location')),
    `expected the underlying reason to be surfaced, got: ${JSON.stringify(doc.action.runLog)}`,
  );
});

// ── runAuthoring: drill engine ───────────────────────────────────────────

test('runAuthoring: drill bundle active -> ready, evidence includes drillSubtype', async () => {
  const decisionStore = { dec1: makeDecisionDoc() };
  const AgentDecision = makeAgentDecisionModel(decisionStore);

  const assessmentStore = { a1: bundleAssessment({ type: 'drill', bundleId: 'bundle1' }) };
  const Assessment = makeAssessmentModel(assessmentStore);
  const bundleStore = { bundle1: bundleDoc({ status: 'active', drill_subtype: 'refactor' }) };
  const ArtifactBundle = makeArtifactBundleModel(bundleStore);

  const authoring = { authorDrill: async () => assessmentStore.a1 };

  await runAuthoring({ decisionId: 'dec1', assessmentId: 'a1' }, { AgentDecision, Assessment, ArtifactBundle, authoring });

  const result = decisionStore.dec1.action.result;
  assert.strictEqual(result.status, 'ready');
  assert.strictEqual(result.engine, 'drill');
  assert.strictEqual(result.evidence.drillSubtype, 'refactor');
});

test('runAuthoring: drill missing bundle (no bundleId persisted) -> failed', async () => {
  const decisionStore = { dec1: makeDecisionDoc() };
  const AgentDecision = makeAgentDecisionModel(decisionStore);

  const assessmentStore = { a1: bundleAssessment({ type: 'drill', bundleId: null }) };
  const Assessment = makeAssessmentModel(assessmentStore);
  const ArtifactBundle = makeArtifactBundleModel({});

  const authoring = { authorDrill: async () => assessmentStore.a1 };

  await runAuthoring({ decisionId: 'dec1', assessmentId: 'a1' }, { AgentDecision, Assessment, ArtifactBundle, authoring });

  const result = decisionStore.dec1.action.result;
  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.engine, 'drill');
  const doc = decisionStore.dec1;
  assert.ok(doc.action.runLog.some((e) => /no bundle produced/.test(e.msg)));
});

test('runAuthoring: drill bundle id set but bundle doc missing -> failed', async () => {
  const decisionStore = { dec1: makeDecisionDoc() };
  const AgentDecision = makeAgentDecisionModel(decisionStore);

  const assessmentStore = { a1: bundleAssessment({ type: 'drill', bundleId: 'ghost' }) };
  const Assessment = makeAssessmentModel(assessmentStore);
  const ArtifactBundle = makeArtifactBundleModel({});

  const authoring = { authorDrill: async () => assessmentStore.a1 };

  await runAuthoring({ decisionId: 'dec1', assessmentId: 'a1' }, { AgentDecision, Assessment, ArtifactBundle, authoring });

  const result = decisionStore.dec1.action.result;
  assert.strictEqual(result.status, 'failed');
});

// ── runAuthoring: preflight (fail fast before any engine spend) ─────────

test('runAuthoring: capstone success -> evidence.preflight is "ok"', async () => {
  const decisionStore = { dec1: makeDecisionDoc() };
  const AgentDecision = makeAgentDecisionModel(decisionStore);

  const assessmentStore = { a1: bundleAssessment({ type: 'capstone', bundleId: 'bundle1' }) };
  const Assessment = makeAssessmentModel(assessmentStore);
  const bundleStore = { bundle1: bundleDoc({ status: 'active' }) };
  const ArtifactBundle = makeArtifactBundleModel(bundleStore);

  const authoring = { authorCapstone: async () => assessmentStore.a1 };

  await runAuthoring({ decisionId: 'dec1', assessmentId: 'a1' }, { AgentDecision, Assessment, ArtifactBundle, authoring });

  const result = decisionStore.dec1.action.result;
  assert.strictEqual(result.status, 'ready');
  assert.strictEqual(result.evidence.preflight, 'ok');
});

test('runAuthoring: capstone preflight rejects an invalid roleTrack before any generation call', async () => {
  const decisionStore = { dec1: makeDecisionDoc() };
  const AgentDecision = makeAgentDecisionModel(decisionStore);

  const assessmentStore = {
    a1: bundleAssessment({ type: 'capstone', bundleId: null, configExtra: { roleTrack: 'cobol' } }),
  };
  const Assessment = makeAssessmentModel(assessmentStore);
  const ArtifactBundle = makeArtifactBundleModel({});

  let authorCapstoneCalled = false;
  const authoring = { authorCapstone: async () => { authorCapstoneCalled = true; return assessmentStore.a1; } };

  await runAuthoring({ decisionId: 'dec1', assessmentId: 'a1' }, { AgentDecision, Assessment, ArtifactBundle, authoring });

  assert.strictEqual(authorCapstoneCalled, false, 'no generation call should be made when preflight fails');
  const doc = decisionStore.dec1;
  assert.strictEqual(doc.action.result.status, 'failed');
  assert.strictEqual(doc.action.result.engine, 'capstone');
  assert.ok(/roleTrack must be one of swe, ds, ai_eng/.test(doc.action.result.evidence.preflight));
  assert.ok(
    doc.action.runLog.some((e) => /^I couldn't start generation: roleTrack must be one of/.test(e.msg)),
    `expected a human pre-flight message in the run log, got: ${JSON.stringify(doc.action.runLog)}`,
  );
});

test('runAuthoring: capstone preflight rejects an invalid difficulty before any generation call', async () => {
  const decisionStore = { dec1: makeDecisionDoc() };
  const AgentDecision = makeAgentDecisionModel(decisionStore);

  const assessmentStore = {
    a1: bundleAssessment({ type: 'capstone', bundleId: null, configExtra: { difficulty: 'extreme' } }),
  };
  const Assessment = makeAssessmentModel(assessmentStore);
  const ArtifactBundle = makeArtifactBundleModel({});

  let authorCapstoneCalled = false;
  const authoring = { authorCapstone: async () => { authorCapstoneCalled = true; return assessmentStore.a1; } };

  await runAuthoring({ decisionId: 'dec1', assessmentId: 'a1' }, { AgentDecision, Assessment, ArtifactBundle, authoring });

  assert.strictEqual(authorCapstoneCalled, false);
  assert.strictEqual(decisionStore.dec1.action.result.status, 'failed');
  assert.ok(/difficulty must be one of easy, medium, hard/.test(decisionStore.dec1.action.result.evidence.preflight));
});

test('runAuthoring: capstone preflight rejects when there is no job description, topic hint, or title to build from', async () => {
  const decisionStore = { dec1: makeDecisionDoc() };
  const AgentDecision = makeAgentDecisionModel(decisionStore);

  const assessmentStore = {
    a1: bundleAssessment({ type: 'capstone', bundleId: null, title: '' }),
  };
  const Assessment = makeAssessmentModel(assessmentStore);
  const ArtifactBundle = makeArtifactBundleModel({});

  let authorCapstoneCalled = false;
  const authoring = { authorCapstone: async () => { authorCapstoneCalled = true; return assessmentStore.a1; } };

  await runAuthoring({ decisionId: 'dec1', assessmentId: 'a1' }, { AgentDecision, Assessment, ArtifactBundle, authoring });

  assert.strictEqual(authorCapstoneCalled, false);
  const result = decisionStore.dec1.action.result;
  assert.strictEqual(result.status, 'failed');
  assert.ok(/add a job description or topic hint/.test(result.evidence.preflight));
});

test('runAuthoring: drill preflight rejects an invalid roleTrack before any generation call', async () => {
  const decisionStore = { dec1: makeDecisionDoc() };
  const AgentDecision = makeAgentDecisionModel(decisionStore);

  const assessmentStore = {
    a1: bundleAssessment({ type: 'drill', bundleId: null, configExtra: { roleTrack: 'nope' } }),
  };
  const Assessment = makeAssessmentModel(assessmentStore);
  const ArtifactBundle = makeArtifactBundleModel({});

  let authorDrillCalled = false;
  const authoring = { authorDrill: async () => { authorDrillCalled = true; return assessmentStore.a1; } };

  await runAuthoring({ decisionId: 'dec1', assessmentId: 'a1' }, { AgentDecision, Assessment, ArtifactBundle, authoring });

  assert.strictEqual(authorDrillCalled, false);
  assert.strictEqual(decisionStore.dec1.action.result.status, 'failed');
});

test('runAuthoring: mcq is unaffected by capstone/drill-only preflight checks (evidence.preflight still "ok")', async () => {
  const decisionStore = { dec1: makeDecisionDoc() };
  const AgentDecision = makeAgentDecisionModel(decisionStore);

  const assessmentStore = { a1: baseAssessment({ questions: [passedQuestion(), passedQuestion()] }) };
  const Assessment = makeAssessmentModel(assessmentStore);

  const authoring = {
    authorMcq: async () => assessmentStore.a1,
    regenerateQuestion: async () => {},
  };

  await runAuthoring({ decisionId: 'dec1', assessmentId: 'a1' }, { AgentDecision, Assessment, authoring });

  const result = decisionStore.dec1.action.result;
  assert.strictEqual(result.status, 'ready');
  assert.strictEqual(result.evidence.preflight, 'ok');
});

// ── startRun: engine-aware guards ───────────────────────────────────────

test('startRun: non-authorable type (e.g. unknown/legacy value) -> throws /not authorable/', async () => {
  const assessment = bundleAssessment({ type: 'quiz', bundleId: null, status: 'draft' });
  const deps = {
    isAgentEnabled: () => true,
    Assessment: makeAssessmentModel({ a1: assessment }),
    AgentDecision: makeAgentDecisionModel({}),
    record: async (payload) => ({ _id: 'dec1', action: payload.action }),
  };
  await assert.rejects(
    startRun({ assessmentId: 'a1', institutionId: 'inst1' }, deps),
    /not authorable/
  );
});

test('startRun: interview authoring already generating -> throws /not authorable/', async () => {
  const assessment = interviewAssessment({ authoringStatus: 'generating', status: 'configured' });
  const deps = {
    isAgentEnabled: () => true,
    Assessment: makeAssessmentModel({ a1: assessment }),
    AgentDecision: makeAgentDecisionModel({}),
    record: async (payload) => ({ _id: 'dec1', action: payload.action }),
  };
  await assert.rejects(
    startRun({ assessmentId: 'a1', institutionId: 'inst1' }, deps),
    /not authorable/
  );
});

test('startRun: capstone with no in-flight signal available -> mid-generation sub-guard is skipped, run starts', async () => {
  // Capstone/drill have no cheap "already generating" signal (unlike mcq/interview's
  // config.<type>.authoring.status) — see MID_GENERATION_GUARDED_ENGINES. A draft
  // capstone assessment must be authorable even though we cannot prove no generation
  // is currently in flight.
  const assessment = bundleAssessment({ type: 'capstone', bundleId: null, status: 'draft' });
  let recordedPayload = null;
  const deps = {
    isAgentEnabled: () => true,
    Assessment: makeAssessmentModel({ a1: assessment }),
    AgentDecision: makeAgentDecisionModel({}),
    authoring: { authorCapstone: async () => assessment },
    ArtifactBundle: makeArtifactBundleModel({}),
    record: async (payload) => { recordedPayload = payload; return { _id: 'dec-cap', action: payload.action }; },
  };
  const { decisionId } = await startRun(
    { assessmentId: 'a1', institutionId: 'inst1', cohortId: 'cohort1', brief: 'a capstone' },
    deps
  );
  assert.strictEqual(decisionId, 'dec-cap');
  assert.strictEqual(recordedPayload.action.engine, 'capstone');
});

test('startRun: ledger row carries action.engine matching the assessment type', async () => {
  const assessment = bundleAssessment({ type: 'drill', bundleId: null, status: 'configured' });
  let recordedPayload = null;
  const deps = {
    isAgentEnabled: () => true,
    Assessment: makeAssessmentModel({ a1: assessment }),
    AgentDecision: makeAgentDecisionModel({}),
    authoring: { authorDrill: async () => assessment },
    ArtifactBundle: makeArtifactBundleModel({}),
    record: async (payload) => { recordedPayload = payload; return { _id: 'dec-drill', action: payload.action }; },
  };
  await startRun({ assessmentId: 'a1', institutionId: 'inst1', cohortId: 'cohort1', brief: 'a drill' }, deps);
  assert.strictEqual(recordedPayload.action.engine, 'drill');
});

// ── reapOrphanedRuns ─────────────────────────────────────────────────────

function minutesAgo(n) {
  return new Date(Date.now() - n * 60 * 1000);
}

/** An in-flight (unfinished) author_agent ledger row, createdAt N minutes ago. */
function orphanCandidateDoc({ id = 'dec1', engine = 'mcq', assessmentId = 'a1', ageMinutes = 40 } = {}) {
  return makeDecisionDoc({
    _id: id,
    agentId: 'author_agent',
    institutionId: 'inst1',
    createdAt: minutesAgo(ageMinutes),
    action: {
      kind: 'assessment_authoring_run',
      engine,
      brief: 'brief',
      assessmentId,
      runLog: [{ at: new Date(), msg: 'run queued' }],
      result: null,
    },
  });
}

test('reapOrphanedRuns: row older than window -> row failed + assessment authoring status reset', async () => {
  const decisionStore = { dec1: orphanCandidateDoc({ ageMinutes: 40 }) };
  const AgentDecision = makeAgentDecisionModel(decisionStore);

  const assessmentStore = { a1: baseAssessment({ questions: [], authoringStatus: 'generating' }) };
  const Assessment = makeAssessmentModel(assessmentStore);

  const { reaped } = await reapOrphanedRuns({ olderThanMinutes: 30 }, { AgentDecision, Assessment });

  assert.strictEqual(reaped, 1);

  const row = decisionStore.dec1;
  assert.strictEqual(row.action.result.status, 'failed');
  assert.strictEqual(row.action.result.engine, 'mcq');
  assert.strictEqual(row.action.result.note, 'orphaned');
  assert.ok(row.action.runLog.some((e) => /run orphaned/.test(e.msg)));
  assert.ok(row.marked.includes('action'));

  const assessment = assessmentStore.a1;
  assert.strictEqual(assessment.config.mcq.authoring.status, 'failed');
  assert.strictEqual(assessment.config.mcq.authoring.error, 'run orphaned');
});

test('reapOrphanedRuns: row younger than window -> untouched', async () => {
  const decisionStore = { dec1: orphanCandidateDoc({ ageMinutes: 5 }) };
  const AgentDecision = makeAgentDecisionModel(decisionStore);

  const assessmentStore = { a1: baseAssessment({ questions: [], authoringStatus: 'generating' }) };
  const Assessment = makeAssessmentModel(assessmentStore);

  const { reaped } = await reapOrphanedRuns({ olderThanMinutes: 30 }, { AgentDecision, Assessment });

  assert.strictEqual(reaped, 0);
  assert.strictEqual(decisionStore.dec1.action.result, null);
  assert.strictEqual(assessmentStore.a1.config.mcq.authoring.status, 'generating');
});

test('reapOrphanedRuns: row already finalized (action.result non-null) -> untouched even if old', async () => {
  const decisionStore = {
    dec1: orphanCandidateDoc({ ageMinutes: 90 }),
  };
  decisionStore.dec1.action.result = { status: 'ready', engine: 'mcq', evidence: {}, flagged: [], passes: 1 };
  const AgentDecision = makeAgentDecisionModel(decisionStore);
  const Assessment = makeAssessmentModel({ a1: baseAssessment({ questions: [], authoringStatus: 'ready' }) });

  const { reaped } = await reapOrphanedRuns({ olderThanMinutes: 30 }, { AgentDecision, Assessment });

  assert.strictEqual(reaped, 0);
  assert.strictEqual(decisionStore.dec1.action.result.status, 'ready');
});

test('reapOrphanedRuns: capstone row (no authoring flag) -> row failed, no assessment write attempted', async () => {
  const decisionStore = { dec1: orphanCandidateDoc({ engine: 'capstone', ageMinutes: 60 }) };
  const AgentDecision = makeAgentDecisionModel(decisionStore);

  const Assessment = {
    async findById() { throw new Error('should not be called'); },
    async updateOne() { throw new Error('capstone has no authoring flag — updateOne must not be called'); },
  };

  const { reaped } = await reapOrphanedRuns({ olderThanMinutes: 30 }, { AgentDecision, Assessment });

  assert.strictEqual(reaped, 1);
  const row = decisionStore.dec1;
  assert.strictEqual(row.action.result.status, 'failed');
  assert.strictEqual(row.action.result.engine, 'capstone');
});

test('reapOrphanedRuns: per-row failure isolation — one row throwing on save does not stop the others', async () => {
  const badDoc = orphanCandidateDoc({ id: 'dec-bad', assessmentId: 'a-bad', ageMinutes: 45 });
  badDoc.save = async () => { throw new Error('save exploded'); };
  const goodDoc = orphanCandidateDoc({ id: 'dec-good', assessmentId: 'a-good', ageMinutes: 45 });

  const decisionStore = { 'dec-bad': badDoc, 'dec-good': goodDoc };
  const AgentDecision = makeAgentDecisionModel(decisionStore);

  const assessmentStore = {
    'a-bad': baseAssessment({ questions: [], authoringStatus: 'generating' }),
    'a-good': baseAssessment({ questions: [], authoringStatus: 'generating' }),
  };
  assessmentStore['a-bad']._id = 'a-bad';
  assessmentStore['a-good']._id = 'a-good';
  const Assessment = makeAssessmentModel(assessmentStore);

  const { reaped } = await reapOrphanedRuns({ olderThanMinutes: 30 }, { AgentDecision, Assessment });

  // Only the good row counts as reaped — the bad row's save() throw is caught
  // and swallowed (per-row isolation), never propagating out of the sweep.
  assert.strictEqual(reaped, 1);
  assert.strictEqual(goodDoc.action.result.status, 'failed');
  assert.strictEqual(assessmentStore['a-good'].config.mcq.authoring.status, 'failed');
});

test('reapOrphanedRuns: no orphaned rows -> reaped 0, never throws', async () => {
  const AgentDecision = makeAgentDecisionModel({});
  const Assessment = makeAssessmentModel({});
  const { reaped } = await reapOrphanedRuns({ olderThanMinutes: 30 }, { AgentDecision, Assessment });
  assert.strictEqual(reaped, 0);
});

// ── createAndAuthor: the one-prompt path (parseBrief -> createAssessment -> ──
// ── the EXISTING startRun/runAuthoring, never reimplemented) ─────────────

const mcqSpec = {
  type: 'mcq',
  title: 'Aptitude Test',
  config: { mcq: { questionCount: 20, totalQuestions: 30, durationSeconds: 1800, assessmentType: 'mixed', topic: 'Aptitude' } },
};

function createAndAuthorDeps({ agentEnabled = true, spec, createAssessmentImpl } = {}) {
  const decisionStore = {};
  const AgentDecision = makeAgentDecisionModel(decisionStore);
  const assessmentStore = {};
  const Assessment = makeAssessmentModel(assessmentStore);

  const deps = {
    isAgentEnabled: () => agentEnabled,
    AgentDecision,
    Assessment,
    InstitutionCohort: { findOne: () => ({ select: async () => null }) },
    assessmentSpecService: {
      parseBrief: async () => {
        if (spec === undefined) throw new Error('spec fixture not provided');
        return spec;
      },
    },
    assessmentService: {
      createAssessment: createAssessmentImpl || (async (scope, payload) => {
        const doc = { _id: 'a1', institutionId: scope.institutionId, status: 'draft', type: payload.type, config: payload.config, createdBy: payload.createdBy };
        assessmentStore.a1 = doc;
        return doc;
      }),
    },
    authoring: {
      authorMcq: async () => assessmentStore.a1,
      authorInterview: async () => assessmentStore.a1,
      authorCapstone: async () => assessmentStore.a1,
      authorDrill: async () => assessmentStore.a1,
      regenerateQuestion: async () => {},
    },
    // Real record() is exercised here (not a stub) — it just needs the fake
    // AgentDecision above, which the spread of `d` into d.record(payload, d)
    // supplies.
    record: require('../../agentDecisionService').record,
  };

  return { deps, decisionStore, assessmentStore };
}

test('createAndAuthor: agent disabled -> throws /disabled/', async () => {
  const { deps } = createAndAuthorDeps({ agentEnabled: false, spec: mcqSpec });
  await assert.rejects(
    createAndAuthor({ institutionId: 'inst1', cohortId: 'c1', actorInstitutionUserId: 'iu1', brief: 'x' }, deps),
    /disabled/
  );
});

test('createAndAuthor: unparseable brief -> throws "could not understand the brief"', async () => {
  const { deps } = createAndAuthorDeps({ spec: mcqSpec });
  deps.assessmentSpecService.parseBrief = async () => {
    throw new Error('analyzeWithClaude: response contained no JSON object');
  };
  await assert.rejects(
    createAndAuthor({ institutionId: 'inst1', cohortId: 'c1', actorInstitutionUserId: 'iu1', brief: 'gibberish' }, deps),
    /could not understand the brief/
  );
});

test('createAndAuthor: cohort not owned by institution -> "cohort not found"', async () => {
  const { deps } = createAndAuthorDeps({
    spec: mcqSpec,
    createAssessmentImpl: async () => { throw new Error('COHORT_NOT_FOUND'); },
  });
  await assert.rejects(
    createAndAuthor({ institutionId: 'inst1', cohortId: 'nope', actorInstitutionUserId: 'iu1', brief: 'x' }, deps),
    /cohort not found/
  );
});

test('createAndAuthor: other createAssessment errors propagate unchanged (not mistranslated)', async () => {
  const { deps } = createAndAuthorDeps({
    spec: mcqSpec,
    createAssessmentImpl: async () => { throw new Error('BAD_WINDOW'); },
  });
  await assert.rejects(
    createAndAuthor({ institutionId: 'inst1', cohortId: 'c1', actorInstitutionUserId: 'iu1', brief: 'x' }, deps),
    /BAD_WINDOW/
  );
});

test('createAndAuthor: happy path wires parseBrief -> createAssessment -> startRun, tags the ledger row', async () => {
  const { deps, decisionStore, assessmentStore } = createAndAuthorDeps({ spec: mcqSpec });

  let cohortQuery = null;
  deps.InstitutionCohort = {
    findOne: (q) => { cohortQuery = q; return { select: async () => ({ label: 'CSE Final Year' }) }; },
  };

  let parseBriefArgs = null;
  deps.assessmentSpecService.parseBrief = async (args) => { parseBriefArgs = args; return mcqSpec; };

  let createAssessmentArgs = null;
  deps.assessmentService.createAssessment = async (scope, payload) => {
    createAssessmentArgs = { scope, payload };
    const doc = { _id: 'a1', institutionId: scope.institutionId, status: 'draft', type: payload.type, config: payload.config };
    assessmentStore.a1 = doc;
    return doc;
  };

  const result = await createAndAuthor(
    { institutionId: 'inst1', cohortId: 'c1', actorInstitutionUserId: 'iu1', brief: '20-question aptitude MCQ' },
    deps
  );

  // cohort-label lookup used for the prompt only, scoped to the caller's institution
  assert.deepStrictEqual(cohortQuery, { _id: 'c1', institutionId: 'inst1' });
  assert.strictEqual(parseBriefArgs.brief, '20-question aptitude MCQ');
  assert.strictEqual(parseBriefArgs.cohortLabel, 'CSE Final Year');

  // createAssessment received the parsed spec, scoped by institution, attributed to the actor
  assert.strictEqual(createAssessmentArgs.scope.institutionId, 'inst1');
  assert.strictEqual(createAssessmentArgs.payload.cohortId, 'c1');
  assert.strictEqual(createAssessmentArgs.payload.type, 'mcq');
  assert.strictEqual(createAssessmentArgs.payload.title, 'Aptitude Test');
  assert.strictEqual(createAssessmentArgs.payload.createdBy, 'iu1');

  assert.strictEqual(result.assessmentId, 'a1');
  assert.ok(result.decisionId, 'expected a decisionId');
  assert.deepStrictEqual(result.spec, mcqSpec);

  // createAndAuthor passes createdByAgent: true into startRun, which writes it
  // into the record() payload atomically at row creation (see startRun) — NOT
  // via a post-hoc findById/save, which would race runAuthoring's
  // fire-and-forget mutations of this same row.
  const row = decisionStore[result.decisionId];
  assert.ok(row, 'expected the ledger row to exist');
  assert.strictEqual(row.agentId, 'author_agent');
  assert.strictEqual(row.action.engine, 'mcq');
  assert.strictEqual(row.action.createdByAgent, true);
  assert.strictEqual(row.action.assessmentId, 'a1');
});

test('createAndAuthor: performs no extra findById/save on the decision row itself (no lost-write race with runAuthoring)', async () => {
  const { deps, decisionStore, assessmentStore } = createAndAuthorDeps({ spec: mcqSpec });

  // startRun's own guard needs ONE real read of the freshly created assessment
  // to proceed. Any read after that is runAuthoring's fire-and-forget background
  // job re-reading the assessment — freeze it there (never resolve) so that job
  // never reaches the AgentDecision row at all. That isolates what createAndAuthor
  // itself does to the ledger row from what the background run does.
  let assessmentFindByIdCalls = 0;
  deps.Assessment = {
    findById: async (id) => {
      assessmentFindByIdCalls += 1;
      if (assessmentFindByIdCalls === 1) return assessmentStore[id] || null;
      return new Promise(() => {}); // never resolves
    },
  };

  const baseAgentDecision = makeAgentDecisionModel(decisionStore);
  let decisionFindByIdCalls = 0;
  const AgentDecision = {
    ...baseAgentDecision,
    findById: async (id) => {
      decisionFindByIdCalls += 1;
      return baseAgentDecision.findById(id);
    },
  };
  deps.AgentDecision = AgentDecision;

  const result = await createAndAuthor(
    { institutionId: 'inst1', cohortId: 'c1', actorInstitutionUserId: 'iu1', brief: '20-question aptitude MCQ' },
    deps
  );

  assert.strictEqual(decisionFindByIdCalls, 0, 'createAndAuthor must never findById the decision row itself');
  const row = decisionStore[result.decisionId];
  assert.ok(row, 'expected the ledger row to exist');
  assert.strictEqual(row.saveCalls || 0, 0, 'createAndAuthor must never save the decision row itself');
  assert.strictEqual(row.action.createdByAgent, true, 'the flag must already be set from record() time');
});

// ── buildObjectiveContext ────────────────────────────────────────────────

test('buildObjectiveContext: null template -> null', () => {
  assert.strictEqual(buildObjectiveContext(null), null);
});

test('buildObjectiveContext: compacts specifics + competencies, omitting missing fields', () => {
  const template = {
    label: 'Data Analyst Placement Prep',
    specifics: { targetRole: 'Data Analyst', targetSkill: 'SQL' }, // no targetCompany
    competencies: [
      { name: 'SQL', weight: 8, category: 'core' },
      { name: '', weight: 3 }, // dropped — no name
      { name: 'Excel', weight: 5 },
    ],
  };
  const objective = buildObjectiveContext(template);
  assert.deepStrictEqual(objective, {
    label: 'Data Analyst Placement Prep',
    targetRole: 'Data Analyst',
    targetSkill: 'SQL',
    competencies: [{ name: 'SQL', weight: 8 }, { name: 'Excel', weight: 5 }],
  });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(objective, 'targetCompany'), false);
});

test('buildObjectiveContext: no specifics/competencies -> just the label', () => {
  const objective = buildObjectiveContext({ label: 'Casual Learning' });
  assert.deepStrictEqual(objective, { label: 'Casual Learning' });
});

// ── createAndAuthor: objective grounding (cohort's ObjectiveTemplate) ────

function makeObjectiveTemplateModel(store) {
  return {
    findById(id) {
      const doc = store[id] || null;
      return { select: async () => doc };
    },
  };
}

test('createAndAuthor: cohort with objectiveTemplateId -> objective is loaded and passed into parseBrief', async () => {
  const { deps } = createAndAuthorDeps({ spec: mcqSpec });

  deps.InstitutionCohort = {
    findOne: () => ({
      select: async () => ({ label: 'CSE Final Year', objectiveTemplateId: 'obj1' }),
    }),
  };
  deps.ObjectiveTemplate = makeObjectiveTemplateModel({
    obj1: {
      label: 'Data Analyst Placement Prep',
      specifics: { targetRole: 'Data Analyst' },
      competencies: [{ name: 'SQL', weight: 8 }],
    },
  });

  let parseBriefArgs = null;
  deps.assessmentSpecService.parseBrief = async (args) => { parseBriefArgs = args; return mcqSpec; };

  await createAndAuthor({ institutionId: 'inst1', cohortId: 'c1', actorInstitutionUserId: 'iu1', brief: 'x' }, deps);

  assert.ok(parseBriefArgs.objective, 'expected an objective to be passed to parseBrief');
  assert.strictEqual(parseBriefArgs.objective.label, 'Data Analyst Placement Prep');
  assert.strictEqual(parseBriefArgs.objective.targetRole, 'Data Analyst');
  assert.deepStrictEqual(parseBriefArgs.objective.competencies, [{ name: 'SQL', weight: 8 }]);
});

test('createAndAuthor: cohort with no objectiveTemplateId -> objective is null', async () => {
  const { deps } = createAndAuthorDeps({ spec: mcqSpec });

  deps.InstitutionCohort = {
    findOne: () => ({ select: async () => ({ label: 'CSE Final Year' }) }),
  };

  let parseBriefArgs = null;
  deps.assessmentSpecService.parseBrief = async (args) => { parseBriefArgs = args; return mcqSpec; };

  await createAndAuthor({ institutionId: 'inst1', cohortId: 'c1', actorInstitutionUserId: 'iu1', brief: 'x' }, deps);

  assert.strictEqual(parseBriefArgs.objective, null);
});

test('createAndAuthor: cohort lookup throws -> best-effort, run still proceeds with objective null', async () => {
  const { deps } = createAndAuthorDeps({ spec: mcqSpec });

  deps.InstitutionCohort = {
    findOne: () => { throw new Error('db down'); },
  };

  let parseBriefArgs = null;
  deps.assessmentSpecService.parseBrief = async (args) => { parseBriefArgs = args; return mcqSpec; };

  const result = await createAndAuthor(
    { institutionId: 'inst1', cohortId: 'c1', actorInstitutionUserId: 'iu1', brief: 'x' },
    deps
  );

  assert.ok(result.assessmentId, 'run should still succeed despite the cohort lookup failure');
  assert.strictEqual(parseBriefArgs.objective, null);
  assert.strictEqual(parseBriefArgs.cohortLabel, undefined);
});

// ── listRuns ──────────────────────────────────────────────────────────────

/** Fake AgentDecision model supporting the .find(query).sort().limit() chain listRuns uses. */
function makeListRunsAgentDecisionModel(rows) {
  return {
    find(query) {
      const matched = rows.filter((row) =>
        row.agentId === query.agentId &&
        String(row.institutionId) === String(query.institutionId) &&
        String(row.cohortId) === String(query.cohortId)
      );
      return {
        sort(sortSpec) {
          const dir = sortSpec && sortSpec.createdAt === -1 ? -1 : 1;
          const sorted = [...matched].sort((a, b) => dir * (new Date(a.createdAt) - new Date(b.createdAt)));
          return {
            async limit(n) {
              return sorted.slice(0, n);
            },
          };
        },
      };
    },
  };
}

/** Fake Assessment model supporting the .find({_id:{$in}}).select().lean() chain listRuns uses. */
function makeListRunsAssessmentModel(docs) {
  return {
    find(query) {
      const ids = (query._id && query._id.$in) || [];
      const matched = docs.filter((d) => ids.includes(String(d._id)));
      return {
        select() {
          return { lean: async () => matched };
        },
      };
    },
  };
}

function listRunsRow({ id, institutionId = 'inst1', cohortId = 'c1', engine = 'mcq', assessmentId, result = null, createdAt }) {
  return { _id: id, agentId: 'author_agent', institutionId, cohortId, createdAt, action: { assessmentId, engine, result } };
}

test('listRuns: returns newest-first', async () => {
  const AgentDecision = makeListRunsAgentDecisionModel([
    listRunsRow({ id: 'dec1', assessmentId: 'a1', createdAt: minutesAgo(30) }),
    listRunsRow({ id: 'dec2', assessmentId: 'a2', createdAt: minutesAgo(5) }),
    listRunsRow({ id: 'dec3', assessmentId: 'a3', createdAt: minutesAgo(15) }),
  ]);
  const Assessment = makeListRunsAssessmentModel([
    { _id: 'a1', title: 'Oldest' },
    { _id: 'a2', title: 'Newest' },
    { _id: 'a3', title: 'Middle' },
  ]);

  const { runs } = await listRuns({ institutionId: 'inst1', cohortId: 'c1' }, { AgentDecision, Assessment });

  assert.deepStrictEqual(runs.map((r) => r.decisionId), ['dec2', 'dec3', 'dec1']);
  assert.deepStrictEqual(runs.map((r) => r.assessmentTitle), ['Newest', 'Middle', 'Oldest']);
});

test('listRuns: cross-tenant cohort returns empty (not other institutions\' runs)', async () => {
  const AgentDecision = makeListRunsAgentDecisionModel([
    listRunsRow({ id: 'dec1', institutionId: 'inst-other', cohortId: 'c1', assessmentId: 'a1', createdAt: minutesAgo(5) }),
  ]);
  const Assessment = makeListRunsAssessmentModel([{ _id: 'a1', title: 'Someone else\'s' }]);

  const { runs } = await listRuns({ institutionId: 'inst1', cohortId: 'c1' }, { AgentDecision, Assessment });

  assert.deepStrictEqual(runs, []);
});

test('listRuns: in-progress runs (action.result null) show status "generating"', async () => {
  const AgentDecision = makeListRunsAgentDecisionModel([
    listRunsRow({ id: 'dec1', assessmentId: 'a1', result: null, createdAt: minutesAgo(2) }),
    listRunsRow({ id: 'dec2', assessmentId: 'a2', result: { status: 'ready' }, createdAt: minutesAgo(1) }),
  ]);
  const Assessment = makeListRunsAssessmentModel([{ _id: 'a1', title: 'T1' }, { _id: 'a2', title: 'T2' }]);

  const { runs } = await listRuns({ institutionId: 'inst1', cohortId: 'c1' }, { AgentDecision, Assessment });

  const byId = Object.fromEntries(runs.map((r) => [r.decisionId, r]));
  assert.strictEqual(byId.dec1.status, 'generating');
  assert.strictEqual(byId.dec2.status, 'ready');
});

test('listRuns: respects the limit, capped at MAX_LIST_RUNS_LIMIT (50)', async () => {
  const rows = Array.from({ length: 10 }, (_, i) =>
    listRunsRow({ id: `dec${i}`, assessmentId: `a${i}`, createdAt: minutesAgo(i) })
  );
  const AgentDecision = makeListRunsAgentDecisionModel(rows);
  const Assessment = makeListRunsAssessmentModel(rows.map((r, i) => ({ _id: `a${i}`, title: `T${i}` })));

  const { runs: defaultRuns } = await listRuns({ institutionId: 'inst1', cohortId: 'c1' }, { AgentDecision, Assessment });
  assert.strictEqual(defaultRuns.length, 5, 'default limit is 5');

  const { runs: capped } = await listRuns({ institutionId: 'inst1', cohortId: 'c1', limit: 1000 }, { AgentDecision, Assessment });
  assert.strictEqual(capped.length, 10, 'limit is capped, not literally 1000, but there are only 10 rows here');
});

test('listRuns: no assessmentId on a row -> assessmentTitle null, no crash', async () => {
  const AgentDecision = makeListRunsAgentDecisionModel([
    listRunsRow({ id: 'dec1', assessmentId: undefined, createdAt: minutesAgo(1) }),
  ]);
  const Assessment = makeListRunsAssessmentModel([]);

  const { runs } = await listRuns({ institutionId: 'inst1', cohortId: 'c1' }, { AgentDecision, Assessment });

  assert.strictEqual(runs[0].assessmentId, null);
  assert.strictEqual(runs[0].assessmentTitle, null);
});

test('listRuns: no rows -> empty array, Assessment.find never called (no wasted batch lookup)', async () => {
  const AgentDecision = makeListRunsAgentDecisionModel([]);
  let assessmentFindCalled = false;
  const Assessment = { find: () => { assessmentFindCalled = true; return { select: () => ({ lean: async () => [] }) }; } };

  const { runs } = await listRuns({ institutionId: 'inst1', cohortId: 'c1' }, { AgentDecision, Assessment });

  assert.deepStrictEqual(runs, []);
  assert.strictEqual(assessmentFindCalled, false);
});

// ── humanizeAuthoringFailure / describeAuthoringFailure — pure mapping ────────

test('humanizeAuthoringFailure: CAPSTONE_GEN_FAILED -> quality-check sentence', () => {
  assert.match(humanizeAuthoringFailure('CAPSTONE_GEN_FAILED'), /failed its own quality checks/);
});

test('humanizeAuthoringFailure: DRILL_GEN_FAILED -> same quality-check sentence', () => {
  assert.strictEqual(humanizeAuthoringFailure('DRILL_GEN_FAILED'), humanizeAuthoringFailure('CAPSTONE_GEN_FAILED'));
});

test('humanizeAuthoringFailure: NOT_FOUND -> vanished-assessment sentence', () => {
  assert.match(humanizeAuthoringFailure('NOT_FOUND'), /vanished before authoring could finish/);
});

test('humanizeAuthoringFailure: BAD_CONFIG -> brief-detail sentence', () => {
  assert.match(humanizeAuthoringFailure('BAD_CONFIG'), /didn't give enough to build this/);
});

test('humanizeAuthoringFailure: unknown code -> kept, prefixed with "authoring failed: "', () => {
  assert.strictEqual(humanizeAuthoringFailure('SOME_WEIRD_CODE'), 'authoring failed: SOME_WEIRD_CODE');
});

test('humanizeAuthoringFailure: no code -> "authoring failed: unknown error"', () => {
  assert.strictEqual(humanizeAuthoringFailure(null), 'authoring failed: unknown error');
  assert.strictEqual(humanizeAuthoringFailure(undefined), 'authoring failed: unknown error');
});

test('describeAuthoringFailure: retains the raw code separately from the human log message', () => {
  const { code, logMsg } = describeAuthoringFailure(new Error('BAD_CONFIG'));
  assert.strictEqual(code, 'BAD_CONFIG');
  assert.match(logMsg, /didn't give enough to build this/);
  assert.ok(!logMsg.includes('BAD_CONFIG'), 'human log message should not leak the raw code');
});

test('describeAuthoringFailure: appends a trimmed .detail when present', () => {
  const err = new Error('CAPSTONE_GEN_FAILED');
  err.detail = '  seeded_mistakes_fail: bad location  ';
  const { code, logMsg } = describeAuthoringFailure(err);
  assert.strictEqual(code, 'CAPSTONE_GEN_FAILED');
  assert.ok(logMsg.includes('seeded_mistakes_fail: bad location'));
  assert.ok(!logMsg.startsWith(' '), 'detail should be trimmed before appending');
});

test('describeAuthoringFailure: truncates an overlong .detail', () => {
  const err = new Error('CAPSTONE_GEN_FAILED');
  err.detail = 'x'.repeat(1000);
  const { logMsg } = describeAuthoringFailure(err);
  assert.ok(logMsg.length < 500, `expected a truncated log message, got length ${logMsg.length}`);
});

test('describeAuthoringFailure: no .detail -> just the human sentence, no dangling separator', () => {
  const { logMsg } = describeAuthoringFailure(new Error('NOT_FOUND'));
  assert.ok(!logMsg.includes(' — '), `expected no detail separator, got: ${logMsg}`);
});

// ── runPreflight ──────────────────────────────────────────────────────────

test('runPreflight: mcq/interview are always ok — capstone/drill-only checks do not apply', () => {
  assert.deepStrictEqual(runPreflight('mcq', { institutionId: 'inst1', config: {} }), { ok: true });
  assert.deepStrictEqual(runPreflight('interview', { institutionId: 'inst1', config: {} }), { ok: true });
});

test('runPreflight: no assessment loaded -> ok (defers to the per-engine NOT_FOUND path)', () => {
  assert.deepStrictEqual(runPreflight('capstone', null), { ok: true });
});

test('runPreflight: assessment with no institutionId -> fails', () => {
  const result = runPreflight('capstone', { config: { capstone: {} }, title: 'x' });
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /isn't linked to an institution/);
});

test('runPreflight: capstone with everything absent -> ok (defaults apply downstream, same as before)', () => {
  const result = runPreflight('capstone', { institutionId: 'inst1', title: 'Backend Capstone', config: { capstone: {} } });
  assert.deepStrictEqual(result, { ok: true });
});

test('runPreflight: capstone with an invalid (present) roleTrack -> fails with the enum listed', () => {
  const result = runPreflight('capstone', {
    institutionId: 'inst1',
    title: 'x',
    config: { capstone: { roleTrack: 'php' } },
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /roleTrack must be one of swe, ds, ai_eng/);
});

test('runPreflight: capstone with an invalid (present) difficulty -> fails with the enum listed', () => {
  const result = runPreflight('capstone', {
    institutionId: 'inst1',
    title: 'x',
    config: { capstone: { difficulty: 'nightmare' } },
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /difficulty must be one of easy, medium, hard/);
});

test('runPreflight: capstone with a blank (present) language -> fails', () => {
  const result = runPreflight('capstone', {
    institutionId: 'inst1',
    title: 'x',
    config: { capstone: { language: '   ' } },
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /language cannot be blank/);
});

test('runPreflight: capstone with no jobDescription, topicHint, or title -> fails', () => {
  const result = runPreflight('capstone', { institutionId: 'inst1', config: { capstone: {} } });
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /add a job description or topic hint/);
});

test('runPreflight: capstone with only a topicHint (no jobDescription/title) -> ok', () => {
  const result = runPreflight('capstone', {
    institutionId: 'inst1',
    config: { capstone: { topicHint: 'inventory management' } },
  });
  assert.deepStrictEqual(result, { ok: true });
});

test('runPreflight: drill does not require a jobDescription/topicHint (capstone-only check)', () => {
  const result = runPreflight('drill', { institutionId: 'inst1', config: { drill: { roleTrack: 'swe', difficulty: 'easy' } } });
  assert.deepStrictEqual(result, { ok: true });
});
