'use strict';

/**
 * e2b sandbox adapter. Implements the SandboxAdapter interface defined in
 * `adapterInterface.js`. Wraps `@e2b/code-interpreter`.
 *
 * API patterns confirmed by WS0 spike (see experiments/sandbox-spike/REPORT.md):
 *   - Sandbox.create() returns in ~1s (target was 8s)
 *   - sbx.files.write() fires multiple inotify events per write (dedup needed)
 *   - sbx.commands.start({ background: true }) returns a handle with .pid
 *   - sbx.commands.kill(pid) works for non-reaped sandboxes
 *   - sbx.getMetrics() returns { cpuUsedPct, memUsedMiB, ... }
 *   - Default egress is OPEN — locked down by template (see TEMPLATE_BY_LANG)
 *   - Fork bombs reap the whole sandbox (recovery via fresh provision)
 *
 * Caller note: this adapter assumes process.env.E2B_API_KEY is set. The SDK
 * reads it from env at construction time.
 */

const { Sandbox } = require('@e2b/code-interpreter');
const { assertAdapter } = require('./adapterInterface');

/**
 * Maps our role-track + language preference to the e2b template name.
 * Templates are configured separately in e2b (Phase B WS2 task: bake
 * iptables egress lockdown into custom templates).
 *
 * Default template falls back to e2b's base image — open egress, no
 * preinstalled framework. Use this only for dev/spike.
 */
const TEMPLATE_BY_LANG = {
  python: process.env.E2B_TEMPLATE_PYTHON || undefined,         // → default
  javascript: process.env.E2B_TEMPLATE_NODE || undefined,
  typescript: process.env.E2B_TEMPLATE_NODE || undefined,
  java: process.env.E2B_TEMPLATE_JAVA || undefined,
  sql: process.env.E2B_TEMPLATE_PYTHON || undefined,            // SQL runs in Python sandbox
  // Phase 3 languages. Each maps to a locked template id when the env var is
  // set; when unset, templateFor() returns undefined and the sandbox falls
  // back to e2b's default image (open egress) — so these languages WORK
  // immediately, and tighten to locked egress once the Docker templates are
  // built + the env vars populated. Kotlin shares the JVM/Maven Java box.
  go: process.env.E2B_TEMPLATE_GO || undefined,
  rust: process.env.E2B_TEMPLATE_RUST || undefined,
  kotlin: process.env.E2B_TEMPLATE_KOTLIN || process.env.E2B_TEMPLATE_JAVA || undefined,
  swift: process.env.E2B_TEMPLATE_SWIFT || undefined,
  cpp: process.env.E2B_TEMPLATE_CPP || undefined,
};

function templateFor(image) {
  // image may be a language ('python') or a stack_variant ('nextjs', 'fastapi').
  // For the MVP we map language only — stack_variant comes from the bundle's
  // starter_repo and is handled by uploading files into the template's base.
  return TEMPLATE_BY_LANG[image] || undefined;
}

// e2b hard caps sandbox `timeoutMs` at 1 hour. Capstones can run up to 90 min,
// so we provision at the hard cap and extend the timeout periodically while
// the session is active (see `extendTimeout` below + heartbeat in orchestrator).
const E2B_MAX_TIMEOUT_MS = 60 * 60 * 1000;
// Safety margin so we don't tickle the boundary.
const PROVISION_TIMEOUT_MS = 55 * 60 * 1000;

async function provision({ image, files = [], env = {}, limits = {} } = {}) {
  const t0 = Date.now();
  const tpl = templateFor(image);
  const requested = limits.wallClockMs || PROVISION_TIMEOUT_MS;
  const timeoutMs = Math.min(requested, E2B_MAX_TIMEOUT_MS - 60_000);
  const sbx = await Sandbox.create({
    ...(tpl ? { template: tpl } : {}),
    envs: env,
    timeoutMs,
  });

  for (const f of files) {
    await sbx.files.write(f.path, f.content);
  }

  return {
    sandboxId: sbx.sandboxId,
    hostUrl: typeof sbx.getHost === 'function' ? sbx.getHost(3000) : undefined,
    provisionMs: Date.now() - t0,
  };
}

/**
 * Extend an active sandbox's auto-kill timeout. e2b allows setting the
 * timeout on a connected sandbox at any time, clamped to the per-sandbox
 * 1-hour cap. We call this from the orchestrator's status-poll path so
 * a learner's 90-min capstone stays alive past the 55-min initial cap.
 *
 * No-op when the sandbox is gone (treated as success — the caller doesn't
 * need to differentiate).
 */
async function extendTimeout(sandboxId, requestedMs) {
  try {
    const sbx = await connect(sandboxId);
    const safeMs = Math.min(requestedMs || PROVISION_TIMEOUT_MS, E2B_MAX_TIMEOUT_MS - 60_000);
    if (typeof sbx.setTimeout === 'function') {
      await sbx.setTimeout(safeMs);
      return { extended: true, timeoutMs: safeMs };
    }
    return { extended: false, reason: 'setTimeout_unavailable' };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[e2bAdapter] extendTimeout failed for ${sandboxId}: ${err.message}`);
    return { extended: false, error: err.message };
  }
}

async function connect(sandboxId) {
  return Sandbox.connect(sandboxId);
}

async function uploadFiles(sandboxId, files) {
  const sbx = await connect(sandboxId);
  for (const f of files) {
    await sbx.files.write(f.path, f.content);
  }
}

async function readFile(sandboxId, path) {
  const sbx = await connect(sandboxId);
  return sbx.files.read(path);
}

async function runCommand(sandboxId, cmd, { timeoutMs = 30_000 } = {}) {
  const sbx = await connect(sandboxId);
  const t0 = Date.now();
  // e2b's runCommand throws on non-zero exit by default. We catch + surface
  // the result so callers can inspect exit codes (test runs commonly exit
  // non-zero, that's not an SDK error).
  try {
    const r = await sbx.commands.run(cmd, { timeoutMs });
    return {
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      exitCode: r.exitCode ?? 0,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    if (err.result) {
      return {
        stdout: err.result.stdout || '',
        stderr: err.result.stderr || '',
        exitCode: err.result.exitCode ?? -1,
        durationMs: Date.now() - t0,
      };
    }
    throw err;
  }
}

async function startBackgroundCommand(sandboxId, cmd) {
  const sbx = await connect(sandboxId);
  const handle = await sbx.commands.start(cmd, { background: true });
  return { pid: handle.pid };
}

async function killCommand(sandboxId, pid) {
  const sbx = await connect(sandboxId);
  await sbx.commands.kill(pid);
}

async function watchFileEvents(sandboxId, onEvent) {
  const sbx = await connect(sandboxId);
  // e2b fires create + modify + close per write (WS0.3 finding). Callers
  // dedupe by (path, content_hash) in recordingService.
  const watcher = await sbx.files.watchDir('/home/user', (e) => {
    onEvent({
      t: new Date().toISOString(),
      path: e.name,
      type: mapFsEventType(e.type),
    });
  });
  return async () => {
    await watcher.stop();
  };
}

function mapFsEventType(e2bType) {
  // e2b's FilesystemEventType enum: 0 = chmod, 1 = create, 2 = remove, 3 = rename, 4 = write
  // Surface our coarser taxonomy.
  switch (e2bType) {
    case 1: return 'create';
    case 2: return 'delete';
    case 4: return 'write';
    default: return 'modify';
  }
}

async function getMetrics(sandboxId) {
  const sbx = await connect(sandboxId);
  const m = await sbx.getMetrics();
  const last = Array.isArray(m) ? m[m.length - 1] : m;
  if (!last) return { cpuPct: 0, memMb: 0 };
  return {
    cpuPct: last.cpuUsedPct ?? last.cpu_used_pct ?? 0,
    // WS0 spike showed memUsedMiB came back '?' for one case — be defensive.
    memMb: Number(last.memUsedMiB ?? last.mem_used_mb ?? 0) || 0,
    networkBytes: last.networkBytes,
  };
}

async function isAlive(sandboxId) {
  try {
    const sbx = await connect(sandboxId);
    if (typeof sbx.isRunning === 'function') return await sbx.isRunning();
    // Fallback: probe with echo
    const r = await sbx.commands.run('echo alive', { timeoutMs: 3_000 });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Confirms the egress lockdown bootstrap ran inside the sandbox.
 *
 * The custom templates (infra/e2b-templates/<lang>-locked/) drop the
 * marker file `/var/lib/scaleup/egress-locked` after iptables rules are
 * applied. If the sandbox booted from the default e2b template (no
 * lockdown), the file is absent and we surface { locked: false }.
 *
 * Caller (sandboxOrchestrator) refuses to mark the session 'ready' when
 * E2B_REQUIRE_EGRESS_LOCKDOWN=true and locked === false.
 */
async function verifyEgressLockdown(sandboxId) {
  try {
    const sbx = await connect(sandboxId);
    const r = await sbx.commands.run(
      'cat /var/lib/scaleup/egress-locked 2>/dev/null || true',
      { timeoutMs: 5_000 }
    );
    const stamp = (r.stdout || '').trim();
    return { locked: stamp.length > 0, lockedAt: stamp || undefined };
  } catch {
    return { locked: false };
  }
}

async function destroy(sandboxId) {
  try {
    const sbx = await connect(sandboxId);
    await sbx.kill();
  } catch {
    // Already gone or unreachable — fine for destroy semantics.
  }
}

const adapter = {
  provision,
  uploadFiles,
  readFile,
  runCommand,
  startBackgroundCommand,
  killCommand,
  watchFileEvents,
  getMetrics,
  isAlive,
  destroy,
  verifyEgressLockdown,
  extendTimeout,
};

assertAdapter(adapter, 'e2b');

module.exports = adapter;
