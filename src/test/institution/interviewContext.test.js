'use strict';
/**
 * Tests for the context parameter in interviewService.startInterview.
 *
 * Verifies the additive contract:
 * - context='' (default) → systemInstruction does NOT contain the context block
 * - context='<text>' → systemInstruction DOES contain the context block
 *
 * Uses module-level stubs to avoid DB/redis/queue.
 */
const test = require('node:test');
const assert = require('node:assert');

// ── Stub out dependencies before requiring interviewService ──────────────────
// We need to intercept InterviewSession.create to capture systemInstruction
// without hitting the DB, and stub KnowledgeProfile / past sessions lookup.

const Module = require('module');
const originalLoad = Module._load;

const capturedSessions = [];

// Minimal stubs for InterviewSession
const emptyChain = {
  sort: () => emptyChain,
  limit: () => emptyChain,
  select: () => emptyChain,
  lean: async () => [],
};
const InterviewSessionStub = {
  updateMany: async () => {},
  find: () => emptyChain,
  create: async (doc) => {
    capturedSessions.push(doc);
    return { ...doc, _id: 'ivSessStub' };
  },
};

// Minimal stubs for models the service requires
const stubs = {
  '../models/InterviewSession': InterviewSessionStub,
  '../models/KnowledgeProfile': {
    findOne: async () => null,
  },
  '../config/queue': {
    interviewEvaluationQueue: { add: async () => {} },
    notificationQueue: { add: async () => {} },
  },
  '../utils/apiError': class ApiError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  },
  '../config/aiProvider': {},
  '../config/openai': {},
  '../config/s3': { s3: {}, generateUploadURL: async () => {}, uploadBuffer: async () => {} },
  'node-fetch': async () => {},
  '../services/userContextService': {
    getUserContext: async () => ({}),
    summarize: () => '',
  },
};

Module._load = function (request, parent, isMain) {
  if (stubs[request]) return stubs[request];
  return originalLoad.apply(this, arguments);
};

// Now load the service (stubs already in place)
const interviewService = require('../../services/interviewService');

// Restore module loader
Module._load = originalLoad;

// ── Tests ────────────────────────────────────────────────────────────────────

test('startInterview with no context: systemInstruction does NOT contain context block', async () => {
  capturedSessions.length = 0;

  await interviewService.startInterview('user1', {
    interviewType: 'placement_technical',
    targetRole: 'SDE',
    difficulty: 'moderate',
    abandonExisting: false,
    // context defaults to ''
  });

  assert.ok(capturedSessions.length > 0, 'InterviewSession.create should be called');
  const { systemInstruction } = capturedSessions[0];
  assert.ok(systemInstruction, 'systemInstruction should exist');
  assert.ok(
    !systemInstruction.includes('Ground your questions in this syllabus/context:'),
    'systemInstruction should NOT contain the context block when context is empty'
  );
});

test('startInterview with context: systemInstruction contains the context block', async () => {
  capturedSessions.length = 0;

  await interviewService.startInterview('user1', {
    interviewType: 'placement_technical',
    targetRole: 'SDE',
    difficulty: 'moderate',
    abandonExisting: false,
    context: 'Chapter 1: Data Structures. Chapter 2: Algorithms.',
  });

  assert.ok(capturedSessions.length > 0, 'InterviewSession.create should be called');
  const { systemInstruction } = capturedSessions[0];
  assert.ok(
    systemInstruction.includes('Ground your questions in this syllabus/context:'),
    'systemInstruction should contain the context block when context is provided'
  );
  assert.ok(
    systemInstruction.includes('Chapter 1: Data Structures'),
    'systemInstruction should include the context text'
  );
});
