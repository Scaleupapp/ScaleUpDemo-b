'use strict';

/**
 * Block 7 (Wave 2) — security/ops.
 *
 *  - e2bRunner.runInTempDir keeps the localSandbox interface but executes in
 *    the e2b sandbox (adapter stubbed — no network)
 *  - openaiModels constant is env-backed
 *  - llmRouter pins the haiku ALIAS, not a dated snapshot
 */

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';

const test = require('node:test');
const assert = require('node:assert/strict');

// ── adapterFactory stub (installed before e2bRunner loads) ───────────────────

const calls = { provisions: [], commands: [], destroys: [] };
let commandResult = { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 };
let provisionError = null;

const fakeAdapter = {
  provision: async (opts) => {
    if (provisionError) throw provisionError;
    calls.provisions.push(opts);
    return { sandboxId: 'sb-1', provisionMs: 1 };
  },
  runCommand: async (id, command, opts) => {
    calls.commands.push({ id, command, opts });
    return commandResult;
  },
  destroy: async (id) => { calls.destroys.push(id); },
};

const adapterFactoryPath = require.resolve('../../coding/services/sandbox/adapterFactory');
require.cache[adapterFactoryPath] = {
  id: adapterFactoryPath,
  filename: adapterFactoryPath,
  loaded: true,
  exports: { getSandboxAdapter: () => fakeAdapter },
};

const { runInTempDir } = require('../../coding/services/sandbox/e2bRunner');

test('e2bRunner: same interface as localSandbox, executes in the e2b sandbox', async () => {
  const r = await runInTempDir({
    files: [{ path: 'a.js', content: 'x' }],
    command: 'npm test',
    timeout_ms: 15000,
    language: 'javascript',
  });
  assert.deepEqual(r, { exit_code: 0, stdout: 'ok', stderr: '', timed_out: false });
  assert.equal(calls.provisions[0].image, 'javascript');
  assert.deepEqual(calls.provisions[0].files, [{ path: 'a.js', content: 'x' }]);
  assert.equal(calls.commands[0].command, 'npm test');
  assert.equal(calls.commands[0].opts.timeoutMs, 15000);
  assert.deepEqual(calls.destroys, ['sb-1'], 'sandbox torn down');
});

test('e2bRunner: failing command maps exitCode → exit_code', async () => {
  commandResult = { exitCode: 2, stdout: '', stderr: 'boom', durationMs: 1 };
  const r = await runInTempDir({ files: [], command: 'x', timeout_ms: 1000 });
  assert.equal(r.exit_code, 2);
  assert.equal(r.stderr, 'boom');
  commandResult = { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 };
});

test('e2bRunner: provision failure fails closed (exit 1, never throws)', async () => {
  provisionError = new Error('e2b down');
  const r = await runInTempDir({ files: [], command: 'x' });
  assert.equal(r.exit_code, 1);
  assert.match(r.stderr, /e2b down/);
  provisionError = null;
});

// ── openaiModels constant ────────────────────────────────────────────────────

test('openaiModels: defaults to gpt-4o and honours env override', () => {
  const modPath = require.resolve('../../config/openaiModels');
  delete require.cache[modPath];
  delete process.env.OPENAI_CHAT_MODEL;
  assert.equal(require('../../config/openaiModels').OPENAI_CHAT_MODEL, 'gpt-4o');
  delete require.cache[modPath];
  process.env.OPENAI_CHAT_MODEL = 'gpt-5-test';
  assert.equal(require('../../config/openaiModels').OPENAI_CHAT_MODEL, 'gpt-5-test');
  delete process.env.OPENAI_CHAT_MODEL;
  delete require.cache[modPath];
});

// ── haiku alias pin ──────────────────────────────────────────────────────────

test('llmRouter: drill graders pin the haiku ALIAS (no dated snapshot)', () => {
  const { getRoutingTable } = require('../../coding/services/llmRouter');
  const table = getRoutingTable();
  for (const task of ['drill_grade_prompt', 'drill_grade_verify', 'drill_grade_decompose']) {
    assert.equal(table[task].model, 'claude-haiku-4-5', `${task} must use the alias`);
    assert.ok(!/\d{8}/.test(table[task].model), 'no dated pin');
  }
});
