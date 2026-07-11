'use strict';

/**
 * e2b-backed drop-in replacement for localSandbox.runInTempDir (Wave 2 block 7).
 *
 * localSandbox executed MODEL-INFLUENCED shell commands via `sh -c` ON THE API
 * HOST — a sandbox-escape by construction. This runner keeps the exact same
 * interface but provisions an isolated e2b sandbox (the same provider the
 * capstone harness and contentValidator already use), uploads the files, runs
 * the command, and tears the sandbox down.
 *
 * @param {object} opts
 * @param {{ path: string, content: string }[]} opts.files      — files to materialise
 * @param {string}  opts.command     — shell command to run inside the sandbox
 * @param {number} [opts.timeout_ms] — command timeout in ms (default 15 000)
 * @param {string} [opts.language]   — sandbox image hint (default 'javascript')
 * @returns {Promise<{ exit_code: number, stdout: string, stderr: string, timed_out: boolean }>}
 */

const { getSandboxAdapter } = require('./adapterFactory');

const DEFAULT_TIMEOUT_MS = 15_000;
const PROVISION_GUARD_MS = 90_000;
const SANDBOX_WALL_CLOCK_MS = 10 * 60 * 1000;

// Hard wall-clock guard around e2b SDK calls (network-level hangs are not
// covered by the SDK's own in-sandbox timeout) — same pattern contentValidator
// uses.
function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

async function runInTempDir({ files, command, timeout_ms = DEFAULT_TIMEOUT_MS, language = 'javascript' }) {
  const adapter = getSandboxAdapter();
  let sandboxId = null;
  try {
    const provisioned = await withTimeout(
      adapter.provision({
        image: language,
        files: files || [],
        env: {},
        limits: { wallClockMs: SANDBOX_WALL_CLOCK_MS },
      }),
      PROVISION_GUARD_MS,
      'sandbox provision'
    );
    sandboxId = provisioned.sandboxId;

    const r = await withTimeout(
      adapter.runCommand(sandboxId, command, { timeoutMs: timeout_ms }),
      timeout_ms + 30_000,
      'sandbox command'
    );
    return {
      exit_code: typeof r.exitCode === 'number' ? r.exitCode : 1,
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      timed_out: false,
    };
  } catch (err) {
    const timedOut = /exceeded \d+ms/.test(err.message || '');
    return {
      exit_code: 1,
      stdout: '',
      stderr: `sandbox error: ${err.message}`,
      timed_out: timedOut,
    };
  } finally {
    if (sandboxId) {
      await withTimeout(adapter.destroy(sandboxId), 30_000, 'sandbox destroy').catch(() => {});
    }
  }
}

module.exports = { runInTempDir };
