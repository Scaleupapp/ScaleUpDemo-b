'use strict';

/**
 * Unit tests for src/coding/services/sandbox/localSandbox.js
 *
 * Exercises real shell execution (sh -c). Tests confirm file I/O, exit codes,
 * timeout behaviour, and temp-dir cleanup.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

// ── Module under test ─────────────────────────────────────────────────────────

const { runInTempDir } = require('../../coding/services/sandbox/localSandbox');

// ─────────────────────────────────────────────────────────────────────────────
// Test 1 — writing + reading a file
// ─────────────────────────────────────────────────────────────────────────────

test('localSandbox: writes file and reads it back via shell command', async () => {
  const result = await runInTempDir({
    files: [{ path: 'hello.txt', content: 'world' }],
    command: 'cat hello.txt',
  });

  assert.strictEqual(result.exit_code, 0, `expected exit_code 0, got ${result.exit_code}`);
  assert.ok(
    result.stdout.includes('world'),
    `expected stdout to contain "world", got: ${JSON.stringify(result.stdout)}`
  );
  assert.strictEqual(result.timed_out, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2 — non-zero exit code
// ─────────────────────────────────────────────────────────────────────────────

test('localSandbox: command exiting 7 returns exit_code 7', async () => {
  const result = await runInTempDir({
    files: [],
    command: 'exit 7',
  });

  assert.strictEqual(result.exit_code, 7, `expected exit_code 7, got ${result.exit_code}`);
  assert.strictEqual(result.timed_out, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3 — timeout
// ─────────────────────────────────────────────────────────────────────────────

test('localSandbox: command that sleeps longer than timeout_ms returns timed_out true', async () => {
  const result = await runInTempDir({
    files: [],
    command: 'sleep 5',
    timeout_ms: 500,
  });

  assert.strictEqual(result.timed_out, true, `expected timed_out true, got ${JSON.stringify(result)}`);
}, { timeout: 5000 }); // give node:test enough wall-clock time

// ─────────────────────────────────────────────────────────────────────────────
// Test 4 — temp dir cleanup
// ─────────────────────────────────────────────────────────────────────────────

test('localSandbox: temp directory is removed after the call returns', async () => {
  // We capture the temp dir path by having the command print it, then verify
  // it no longer exists. On macOS os.tmpdir() may return a symlink path
  // (/var/folders/...) while the shell's pwd resolves it to the real path
  // (/private/var/folders/...). We use fs.realpathSync to normalise both.
  const result = await runInTempDir({
    files: [{ path: 'sentinel.txt', content: 'here' }],
    command: 'pwd',
  });

  assert.strictEqual(result.exit_code, 0);
  const tmpDir = result.stdout.trim();

  // The resolved tmpdir base and the resolved path reported by the shell
  // should share the same directory prefix (after symlink resolution).
  const realTmpBase = fs.realpathSync(os.tmpdir());
  const realTmpDir  = tmpDir; // already resolved by the shell

  assert.ok(
    realTmpDir.startsWith(realTmpBase),
    `unexpected tmpDir: ${realTmpDir} (expected to start with ${realTmpBase})`
  );
  assert.ok(
    path.basename(realTmpDir).startsWith('scaleup-sbx-'),
    `expected dir name to start with 'scaleup-sbx-', got: ${path.basename(realTmpDir)}`
  );

  // Must be cleaned up
  assert.strictEqual(
    fs.existsSync(tmpDir),
    false,
    `expected temp dir to be removed, but it still exists: ${tmpDir}`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5 — nested file paths (subdirectory creation)
// ─────────────────────────────────────────────────────────────────────────────

test('localSandbox: creates subdirectories for nested file paths', async () => {
  const result = await runInTempDir({
    files: [{ path: 'sub/dir/nested.txt', content: 'nested_content' }],
    command: 'cat sub/dir/nested.txt',
  });

  assert.strictEqual(result.exit_code, 0);
  assert.ok(result.stdout.includes('nested_content'));
});
