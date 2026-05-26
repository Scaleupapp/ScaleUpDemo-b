'use strict';

/**
 * Unit tests for src/coding/services/compassCoder.js
 *
 * llmRouter.llmCall is replaced with a deterministic stub — no real LLM calls.
 * No DB connection required.
 */

require('dotenv').config();
process.env.OPENAI_API_KEY    = process.env.OPENAI_API_KEY    || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// ── LLM stub — patched before compassCoder is loaded ─────────────────────────

const llmRouter = require('../../coding/services/llmRouter');

let STUB_LLM_RESPONSE = {
  content: [{ type: 'text', text: 'Hi there!' }],
  _meta: { model: 'claude-sonnet-4-6' },
  usage: { input_tokens: 10, output_tokens: 5 },
};

let capturedLlmArgs = null;

llmRouter.llmCall = async (args) => {
  capturedLlmArgs = args;
  return STUB_LLM_RESPONSE;
};

// ── Module under test — loaded AFTER stub is in place ────────────────────────

const { chat, buildSystemPrompt, CODER_SYSTEM_PROMPT } = require('../../coding/services/compassCoder');

// ─────────────────────────────────────────────────────────────────────────────
// 1. CODER_SYSTEM_PROMPT — key phrase checks
// ─────────────────────────────────────────────────────────────────────────────

test('CODER_SYSTEM_PROMPT contains "pair-programmer"', () => {
  assert.ok(
    CODER_SYSTEM_PROMPT.includes('pair-programmer'),
    'Expected CODER_SYSTEM_PROMPT to contain "pair-programmer"'
  );
});

test('CODER_SYSTEM_PROMPT contains "NOT autopilot"', () => {
  assert.ok(
    CODER_SYSTEM_PROMPT.includes('NOT autopilot'),
    'Expected CODER_SYSTEM_PROMPT to contain "NOT autopilot"'
  );
});

test('CODER_SYSTEM_PROMPT contains "push back"', () => {
  assert.ok(
    CODER_SYSTEM_PROMPT.includes('push back'),
    'Expected CODER_SYSTEM_PROMPT to contain "push back"'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. buildSystemPrompt — null context returns base prompt
// ─────────────────────────────────────────────────────────────────────────────

test('buildSystemPrompt(null) → returns just CODER_SYSTEM_PROMPT', () => {
  const result = buildSystemPrompt(null);
  assert.strictEqual(result, CODER_SYSTEM_PROMPT);
});

test('buildSystemPrompt(undefined) → returns just CODER_SYSTEM_PROMPT', () => {
  const result = buildSystemPrompt(undefined);
  assert.strictEqual(result, CODER_SYSTEM_PROMPT);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. buildSystemPrompt — context fields injected
// ─────────────────────────────────────────────────────────────────────────────

test('buildSystemPrompt with brief, language, drill_subtype → all three appear in output', () => {
  const result = buildSystemPrompt({
    brief: 'Refactor this function',
    language: 'python',
    drill_subtype: 'refactor',
  });
  assert.ok(result.includes('Refactor this function'), 'brief missing');
  assert.ok(result.includes('python'), 'language missing');
  assert.ok(result.includes('refactor'), 'drill_subtype missing');
});

test('buildSystemPrompt with brief → starts with CODER_SYSTEM_PROMPT prefix', () => {
  const result = buildSystemPrompt({ brief: 'Fix the bug' });
  assert.ok(result.startsWith(CODER_SYSTEM_PROMPT));
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. buildSystemPrompt — current_files included
// ─────────────────────────────────────────────────────────────────────────────

test('buildSystemPrompt with current_files → file content appears in output', () => {
  const result = buildSystemPrompt({
    current_files: [{ path: 'main.py', content: 'def f():\n    pass' }],
  });
  assert.ok(result.includes('main.py'), 'file path missing');
  assert.ok(result.includes('def f():'), 'file content missing');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. chat — happy path: reply and model extracted correctly
// ─────────────────────────────────────────────────────────────────────────────

test('chat: reply is extracted from LLM response content', async () => {
  STUB_LLM_RESPONSE = {
    content: [{ type: 'text', text: 'Hi there!' }],
    _meta: { model: 'claude-sonnet-4-6' },
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  capturedLlmArgs = null;

  const result = await chat({
    user_id: 'user-123',
    message_history: [{ role: 'user', content: 'Hello' }],
  });

  assert.strictEqual(result.reply, 'Hi there!');
  assert.strictEqual(result.model, 'claude-sonnet-4-6');
});

test('chat: usage is forwarded from LLM response', async () => {
  STUB_LLM_RESPONSE = {
    content: [{ type: 'text', text: 'Hello!' }],
    _meta: { model: 'claude-sonnet-4-6' },
    usage: { input_tokens: 10, output_tokens: 5 },
  };

  const result = await chat({
    user_id: 'user-abc',
    message_history: [{ role: 'user', content: 'Hi' }],
  });

  assert.deepStrictEqual(result.usage, { input_tokens: 10, output_tokens: 5 });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. chat — validation: empty message_history throws
// ─────────────────────────────────────────────────────────────────────────────

test('chat: empty message_history throws', async () => {
  await assert.rejects(
    () => chat({ user_id: 'user-123', message_history: [] }),
    /message_history required/
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. chat — validation: missing user_id throws
// ─────────────────────────────────────────────────────────────────────────────

test('chat: missing user_id throws', async () => {
  await assert.rejects(
    () => chat({ message_history: [{ role: 'user', content: 'Hi' }] }),
    /user_id required/
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. chat — llmCall receives taskId 'compass_coder' and correct messages format
// ─────────────────────────────────────────────────────────────────────────────

test('chat: llmCall receives taskId "compass_coder"', async () => {
  capturedLlmArgs = null;

  await chat({
    user_id: 'user-123',
    message_history: [{ role: 'user', content: 'Help me refactor this' }],
  });

  assert.ok(capturedLlmArgs, 'llmCall was not called');
  assert.strictEqual(capturedLlmArgs.taskId, 'compass_coder');
});

test('chat: llmCall receives messages array with correct role/content shape', async () => {
  capturedLlmArgs = null;

  await chat({
    user_id: 'user-123',
    message_history: [{ role: 'user', content: 'Help me refactor this' }],
  });

  assert.ok(Array.isArray(capturedLlmArgs.messages), 'messages must be an array');
  const msg = capturedLlmArgs.messages[0];
  assert.strictEqual(msg.role, 'user');
  assert.strictEqual(msg.content, 'Help me refactor this');
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. chat — mixed roles passed through correctly
// ─────────────────────────────────────────────────────────────────────────────

test('chat: mixed roles (user, assistant, user) passed through in correct order', async () => {
  capturedLlmArgs = null;

  const history = [
    { role: 'user',      content: 'Can you refactor this?' },
    { role: 'assistant', content: 'Sure, here is a refactored version.' },
    { role: 'user',      content: 'Can you explain why?' },
  ];

  await chat({ user_id: 'user-123', message_history: history });

  const msgs = capturedLlmArgs.messages;
  assert.strictEqual(msgs.length, 3);
  assert.strictEqual(msgs[0].role, 'user');
  assert.strictEqual(msgs[0].content, 'Can you refactor this?');
  assert.strictEqual(msgs[1].role, 'assistant');
  assert.strictEqual(msgs[1].content, 'Sure, here is a refactored version.');
  assert.strictEqual(msgs[2].role, 'user');
  assert.strictEqual(msgs[2].content, 'Can you explain why?');
});

test('chat: non-assistant roles are normalized to "user"', async () => {
  capturedLlmArgs = null;

  await chat({
    user_id: 'user-123',
    message_history: [{ role: 'system', content: 'Some system content' }],
  });

  const msgs = capturedLlmArgs.messages;
  assert.strictEqual(msgs[0].role, 'user');
});
