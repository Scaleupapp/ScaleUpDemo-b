'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { getAdapter } = require('../../services/institution/assessment/engineAdapters');

test('mcq adapter.start clones a Quiz from frozen questions and starts an attempt', async () => {
  let createdQuiz = null, createdAttempt = null;
  const deps = {
    Quiz: { create: async (d) => { createdQuiz = d; return { _id: 'quiz1', ...d }; } },
    QuizAttempt: { create: async (d) => { createdAttempt = d; return { _id: 'att1', ...d }; } },
  };
  const assessment = { _id: 'a1', type: 'mcq', config: { mcq: { questions: [{ questionText: 'q' }], totalQuestions: 1 } } };
  const out = await getAdapter('mcq').start(assessment, 'u1', deps);
  assert.strictEqual(createdQuiz.userId, 'u1');
  assert.deepStrictEqual(createdQuiz.questions, [{ questionText: 'q' }]);
  assert.strictEqual(out.engine.type, 'mcq');
  assert.strictEqual(String(out.engine.quizId), 'quiz1');
  assert.strictEqual(String(out.engine.sessionId), 'att1');
});

test('mcq adapter.readResult reports done with score when the attempt is completed', async () => {
  const deps = { QuizAttempt: { findById: async () => ({ status: 'completed', score: { percentage: 72 }, competencyBreakdown: [{ competency: 'DSA', percentage: 70 }] }) } };
  const r = await getAdapter('mcq').readResult({ engine: { sessionId: 'att1' } }, deps);
  assert.strictEqual(r.done, true);
  assert.strictEqual(r.score, 72);
});

test('mcq adapter.readResult reports not-done while in_progress', async () => {
  const deps = { QuizAttempt: { findById: async () => ({ status: 'in_progress' }) } };
  const r = await getAdapter('mcq').readResult({ engine: { sessionId: 'att1' } }, deps);
  assert.strictEqual(r.done, false);
});

test('capstone adapter.readResult maps graded result', async () => {
  const deps = { CapstoneSession: { findById: async () => ({ status: 'graded', result: { overall_score: 81, integrity_confidence: 'high' } }) } };
  const r = await getAdapter('capstone').readResult({ engine: { sessionId: 's1' } }, deps);
  assert.strictEqual(r.done, true);
  assert.strictEqual(r.score, 81);
  assert.strictEqual(r.integrity, 'high');
});

test('interview adapter.readResult maps evaluated result', async () => {
  const deps = { InterviewSession: { findById: async () => ({ status: 'evaluated', evaluation: { overallScore: 68, integrityReport: { overallIntegrity: 'clean' } } }) } };
  const r = await getAdapter('interview').readResult({ engine: { sessionId: 's1' } }, deps);
  assert.strictEqual(r.done, true);
  assert.strictEqual(r.score, 68);
  assert.strictEqual(r.integrity, 'clean');
});

test('getAdapter throws on unknown type', () => {
  assert.throws(() => getAdapter('essay'));
});

// ── getStartMeta ─────────────────────────────────────────────────────────────

test('interview adapter.getStartMeta returns systemInstruction from InterviewSession', async () => {
  const deps = {
    InterviewSession: {
      findById: async (id) => {
        assert.strictEqual(String(id), 'ivSess1');
        return { systemInstruction: 'SYS' };
      },
    },
  };
  const meta = await getAdapter('interview').getStartMeta({ engine: { sessionId: 'ivSess1' } }, deps);
  assert.strictEqual(meta.systemInstruction, 'SYS');
});

test('interview adapter.getStartMeta returns undefined systemInstruction when session not found', async () => {
  const deps = { InterviewSession: { findById: async () => null } };
  const meta = await getAdapter('interview').getStartMeta({ engine: { sessionId: 'missing' } }, deps);
  assert.strictEqual(meta.systemInstruction, undefined);
});

test('mcq adapter.getStartMeta returns empty object', async () => {
  const meta = await getAdapter('mcq').getStartMeta({ engine: { sessionId: 'att1' } }, {});
  assert.deepStrictEqual(meta, {});
});

test('capstone adapter.getStartMeta returns pairingCode, expiresAt, timeBudgetSeconds (injected deps)', async () => {
  const fakeExpiry = new Date('2030-01-01');
  const deps = {
    pairingService: { mintCode: async () => ({ code: '000000', expiresAt: fakeExpiry }) },
    CapstoneSession: { findById: async () => ({ time_budget_seconds: 3600 }) },
  };
  const meta = await getAdapter('capstone').getStartMeta({ userId: 'u1', engine: { sessionId: 's1' } }, deps);
  assert.strictEqual(meta.pairingCode, '000000');
  assert.strictEqual(meta.expiresAt, fakeExpiry);
  assert.strictEqual(meta.timeBudgetSeconds, 3600);
});

test('capstone adapter.start calls injected startCapstone with bundleId and returns engine {type, sessionId}', async () => {
  let calledWith = null;
  const deps = {
    startCapstone: async (args) => {
      calledWith = args;
      return { session: { _id: 'csess1' } };
    },
  };
  const assessment = { config: { capstone: { bundleId: 'bundle99' } } };
  const out = await getAdapter('capstone').start(assessment, 'user1', deps);
  assert.strictEqual(String(calledWith.bundleId), 'bundle99');
  assert.strictEqual(calledWith.userId, 'user1');
  assert.strictEqual(out.engine.type, 'capstone');
  assert.strictEqual(String(out.engine.sessionId), 'csess1');
});

test('capstone adapter.getStartMeta returns {pairingCode, expiresAt, timeBudgetSeconds} with injected deps', async () => {
  const fakeExpiresAt = new Date('2030-01-01');
  const deps = {
    pairingService: {
      mintCode: async ({ userId, sessionId }) => {
        assert.strictEqual(userId, 'u42');
        assert.strictEqual(String(sessionId), 'csess1');
        return { code: '123456', expiresAt: fakeExpiresAt };
      },
    },
    CapstoneSession: {
      findById: async (id) => {
        assert.strictEqual(String(id), 'csess1');
        return { time_budget_seconds: 5400 };
      },
    },
  };
  const session = { userId: 'u42', engine: { sessionId: 'csess1' } };
  const meta = await getAdapter('capstone').getStartMeta(session, deps);
  assert.strictEqual(meta.pairingCode, '123456');
  assert.strictEqual(meta.expiresAt, fakeExpiresAt);
  assert.strictEqual(meta.timeBudgetSeconds, 5400);
});

test('capstone adapter.getStartMeta returns undefined timeBudgetSeconds when CapstoneSession not found', async () => {
  const deps = {
    pairingService: { mintCode: async () => ({ code: '000000', expiresAt: new Date() }) },
    CapstoneSession: { findById: async () => null },
  };
  const meta = await getAdapter('capstone').getStartMeta({ userId: 'u1', engine: { sessionId: 'missing' } }, deps);
  assert.strictEqual(meta.timeBudgetSeconds, undefined);
});

// ── interview.start — sourceId grounding ─────────────────────────────────────

test('interview adapter.start with config.interview.sourceId (ready): passes context to startInterview', async () => {
  let capturedOpts = null;

  const deps = {
    interviewService: {
      startInterview: async (userId, opts) => {
        capturedOpts = opts;
        return { session: { _id: 'ivSess1' } };
      },
    },
    AssessmentSource: {
      findById: async (id) => ({
        _id: id,
        status: 'ready',
        extractedText: 'Topic 1: Sorting. Topic 2: Searching.',
      }),
    },
  };

  const assessment = {
    config: {
      interview: {
        interviewType: 'placement_technical',
        targetRole: 'SDE',
        difficulty: 'moderate',
        sourceId: 'src42',
      },
    },
  };

  const out = await getAdapter('interview').start(assessment, 'u1', deps);
  assert.ok(capturedOpts, 'startInterview must be called');
  assert.ok(capturedOpts.context, 'context should be passed when sourceId set');
  assert.ok(capturedOpts.context.includes('Sorting'), 'context should include extractedText');
  assert.strictEqual(out.engine.type, 'interview');
});

test('interview adapter.start without sourceId: passes empty context to startInterview', async () => {
  let capturedOpts = null;

  const deps = {
    interviewService: {
      startInterview: async (userId, opts) => {
        capturedOpts = opts;
        return { session: { _id: 'ivSess2' } };
      },
    },
  };

  const assessment = {
    config: {
      interview: {
        interviewType: 'placement_technical',
        targetRole: 'SDE',
        difficulty: 'moderate',
        // no sourceId
      },
    },
  };

  await getAdapter('interview').start(assessment, 'u1', deps);
  assert.ok(capturedOpts, 'startInterview must be called');
  assert.strictEqual(capturedOpts.context, '', 'context should be empty string when no sourceId');
});

test('interview adapter.start with sourceId but source not found: context is empty string', async () => {
  let capturedOpts = null;

  const deps = {
    interviewService: {
      startInterview: async (userId, opts) => {
        capturedOpts = opts;
        return { session: { _id: 'ivSess3' } };
      },
    },
    AssessmentSource: {
      findById: async () => null,
    },
  };

  const assessment = {
    config: {
      interview: {
        interviewType: 'behavioral',
        sourceId: 'missing-src',
      },
    },
  };

  await getAdapter('interview').start(assessment, 'u1', deps);
  assert.strictEqual(capturedOpts.context, '', 'context should be empty when source not found');
});

test('interview adapter.start with sourceId but source not ready: context is empty string', async () => {
  let capturedOpts = null;

  const deps = {
    interviewService: {
      startInterview: async (userId, opts) => {
        capturedOpts = opts;
        return { session: { _id: 'ivSess4' } };
      },
    },
    AssessmentSource: {
      findById: async () => ({ _id: 'srcX', status: 'extracting', extractedText: 'some text' }),
    },
  };

  const assessment = {
    config: {
      interview: { interviewType: 'behavioral', sourceId: 'srcX' },
    },
  };

  await getAdapter('interview').start(assessment, 'u1', deps);
  assert.strictEqual(capturedOpts.context, '', 'context should be empty when source not ready');
});
