'use strict';

const { getSandboxAdapter } = require('../sandbox/adapterFactory');

/**
 * Final-harness runner — provisions a clean sandbox from the learner's
 * final filetree, runs visible_tests + hidden_tests + lint, captures
 * structured pass/fail counts.
 *
 * Why a fresh sandbox (not reuse the learner's): once a session reaches
 * `submitted`, the original sandbox may have been reaped by e2b (per
 * WS0.4 finding for fork-bomb-style crashes). We always re-provision
 * for grading so the run is deterministic.
 *
 * The hidden_tests are NEVER materialised inside the learner's session
 * sandbox — they only run here, post-submit. Anti-cheat by construction.
 *
 * Lint commands are language-specific. For each Tier-1 language we ship
 * a default; the bundle can override via bundle.lint_command if a
 * specific stack needs different tooling (e.g. eslint with custom config).
 */

const DEFAULT_LINT_BY_LANG = {
  python: 'python3 -m ruff check . 2>&1 || true',
  javascript: 'npx --yes eslint --no-eslintrc --rule "no-unused-vars: warn" . 2>&1 || true',
  typescript: 'npx --yes tsc --noEmit 2>&1 || true',
  java: 'find . -name "*.java" -exec javac -d /tmp/out {} + 2>&1 || true',
  sql: 'echo skip-lint',
  // Phase 3 languages — each lints best-effort and never hard-fails the
  // harness (|| true / echo skip-lint), so a missing linter degrades to
  // "no lint signal" rather than a false zero.
  go: 'gofmt -l . 2>&1 || true',
  rust: 'cargo clippy --quiet 2>&1 || cargo check --quiet 2>&1 || true',
  kotlin: 'ktlint 2>&1 || echo skip-lint',
  swift: 'swiftlint 2>&1 || swift build 2>&1 || echo skip-lint',
  cpp: 'find . \\( -name "*.cpp" -o -name "*.cc" \\) -print0 | xargs -0 -r clang++ -fsyntax-only -Wall 2>&1 || true',
};

const HARNESS_TIMEOUT_MS = 60 * 1000; // each test command capped at 60s
const HARNESS_PROVISION_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * @param {object} args
 * @param {{ language: string, lint_command?: string }} args.bundle
 * @param {{ files: Array<{path:string,content:string}> }} args.finalFiles
 * @param {Array<{name:string,command:string}>} args.visibleTests
 * @param {Array<{name:string,command:string}>} args.hiddenTests
 * @returns {Promise<{
 *   visible: Array<{name:string, passed:boolean, exitCode:number, durationMs:number, stderr:string}>,
 *   hidden:  Array<{name:string, passed:boolean, exitCode:number, durationMs:number, stderr:string}>,
 *   lint:    { passed: boolean, output: string, durationMs: number },
 *   provisionMs: number,
 *   teardownMs:  number
 * }>}
 */
async function runFinalHarness({ bundle, finalFiles, visibleTests = [], hiddenTests = [] }) {
  const adapter = getSandboxAdapter();
  const tProv = Date.now();

  const provisioned = await adapter.provision({
    image: bundle.language,
    files: finalFiles || [],
    env: {},
    limits: { wallClockMs: HARNESS_PROVISION_TIMEOUT_MS },
  });
  const provisionMs = Date.now() - tProv;

  const result = {
    visible: [],
    hidden: [],
    lint: { passed: false, output: '', durationMs: 0 },
    provisionMs,
    teardownMs: 0,
  };

  try {
    // Install step — most starters have a package.json or requirements.txt.
    // Run it before tests so the test commands find their deps. Failure here
    // doesn't fail the harness (the test commands will fail naturally and
    // we'll surface the lower correctness score).
    await runInstallStep(adapter, provisioned.sandboxId, bundle.language).catch(() => {});

    // Visible tests
    for (const t of visibleTests) {
      result.visible.push(await runOne(adapter, provisioned.sandboxId, t));
    }
    // Hidden tests — only run server-side, never seen by the learner.
    for (const t of hiddenTests) {
      result.hidden.push(await runOne(adapter, provisioned.sandboxId, t));
    }

    // Lint
    const lintCmd = bundle.lint_command || DEFAULT_LINT_BY_LANG[bundle.language] || 'echo skip-lint';
    const tLint = Date.now();
    const lintRun = await adapter.runCommand(provisioned.sandboxId, lintCmd, {
      timeoutMs: HARNESS_TIMEOUT_MS,
    });
    result.lint = {
      passed: lintRun.exitCode === 0 && !/\b(error|fatal)\b/i.test(lintRun.stderr || ''),
      output: (lintRun.stdout || '') + (lintRun.stderr || ''),
      durationMs: Date.now() - tLint,
    };
  } finally {
    const tDown = Date.now();
    await adapter.destroy(provisioned.sandboxId).catch(() => {});
    result.teardownMs = Date.now() - tDown;
  }

  return result;
}

async function runOne(adapter, sandboxId, test) {
  const tStart = Date.now();
  try {
    const r = await adapter.runCommand(sandboxId, test.command, { timeoutMs: HARNESS_TIMEOUT_MS });
    return {
      name: test.name,
      passed: r.exitCode === 0,
      exitCode: r.exitCode,
      durationMs: Date.now() - tStart,
      stderr: (r.stderr || '').slice(0, 4096),
    };
  } catch (err) {
    return {
      name: test.name,
      passed: false,
      exitCode: -1,
      durationMs: Date.now() - tStart,
      stderr: String(err.message || err).slice(0, 4096),
    };
  }
}

async function runInstallStep(adapter, sandboxId, language) {
  const cmds = {
    python: 'pip install --quiet -r requirements.txt 2>&1 || true',
    javascript: 'npm install --silent --no-audit --no-fund 2>&1 || true',
    typescript: 'npm install --silent --no-audit --no-fund 2>&1 || true',
    java: 'echo skip-install',
    sql: 'echo skip-install',
    // Phase 3 languages — pull deps only if the manifest exists, never hard-fail.
    go: 'test -f go.mod && go mod download 2>&1 || echo skip-install',
    rust: 'test -f Cargo.toml && cargo fetch --quiet 2>&1 || echo skip-install',
    kotlin: 'echo skip-install',
    swift: 'test -f Package.swift && swift package resolve 2>&1 || echo skip-install',
    cpp: 'echo skip-install',
  };
  const c = cmds[language];
  if (!c) return;
  await adapter.runCommand(sandboxId, c, { timeoutMs: 5 * 60 * 1000 });
}

/**
 * Pull the learner's final filetree.
 *
 * Source priority:
 *   1. Live sandbox (if alive) — best fidelity
 *   2. Most recent snapshot from S3 (if `snapshotS3Key` provided)
 *   3. Inline `snapshotFiles` (legacy callers)
 *
 * Returns null if no source is available.
 */
async function pullFinalFiles({ sandboxId, snapshotS3Key, snapshotFiles } = {}) {
  if (sandboxId) {
    const adapter = getSandboxAdapter();
    if (await adapter.isAlive(sandboxId).catch(() => false)) {
      return pullFromSandbox(sandboxId);
    }
  }
  if (snapshotS3Key) {
    // Lazy require avoids a circular dep with snapshotService.
    const snap = await require('../snapshotService').loadSnapshot(snapshotS3Key);
    if (snap?.files?.length) return snap.files;
  }
  if (snapshotFiles && snapshotFiles.length > 0) return snapshotFiles;
  return null;
}

async function pullFromSandbox(sandboxId) {
  const adapter = getSandboxAdapter();
  // Walk the workspace via a `find` command and pull each file. Cheap on
  // typical capstone (< 30 files); we don't try to mirror gitignore here.
  const ls = await adapter.runCommand(
    sandboxId,
    'find /home/user -type f -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/__pycache__/*" 2>&1',
    { timeoutMs: 15_000 }
  );
  const paths = (ls.stdout || '')
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p && p.startsWith('/home/user/'))
    .map((p) => p.replace(/^\/home\/user\//, ''))
    .slice(0, 200);
  const out = [];
  for (const p of paths) {
    try {
      const content = await adapter.readFile(sandboxId, `/home/user/${p}`);
      out.push({ path: p, content });
    } catch {
      // ignore unreadable
    }
  }
  return out;
}

module.exports = {
  runFinalHarness,
  pullFinalFiles,
  HARNESS_TIMEOUT_MS,
  DEFAULT_LINT_BY_LANG,
};
