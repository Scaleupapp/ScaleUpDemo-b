'use strict';

/**
 * Sandbox adapter interface — provider-agnostic contract every concrete
 * adapter (e2b, Daytona, local) implements.
 *
 * Centralising the interface here means caller code (sandboxOrchestrator,
 * compassCoderService, capstoneEvaluator) never has to know which provider
 * is in use. If we swap from e2b to Daytona later, only `adapterFactory.js`
 * changes.
 *
 * Methods are described as JSDoc — JS has no interface keyword, so this
 * file is documentation + a runtime guard (assertAdapter) that throws if a
 * concrete adapter is missing a method.
 */

/**
 * @typedef {Object} SandboxFile
 * @property {string} path     — repo-relative path (e.g. 'src/index.js')
 * @property {string} content  — file content as UTF-8 string
 */

/**
 * @typedef {Object} SandboxLimits
 * @property {number} [wallClockMs]   — sandbox auto-terminate after this many ms (defense in depth)
 * @property {number} [cpuPct]        — soft CPU cap per command (best-effort, provider-dependent)
 * @property {number} [memMb]         — RAM cap (provider-enforced)
 * @property {string} [networkPolicy] — 'open' | 'whitelist:npm,pip' (provider-dependent — see WS0 report §05)
 */

/**
 * @typedef {Object} ProvisionResult
 * @property {string} sandboxId      — provider handle
 * @property {string} [hostUrl]      — optional URL the IDE iframe can load (e2b returns this; Daytona may not)
 * @property {number} provisionMs    — measured time to provision (telemetry)
 */

/**
 * @typedef {Object} CommandResult
 * @property {string} stdout
 * @property {string} stderr
 * @property {number} exitCode
 * @property {number} durationMs
 */

/**
 * @typedef {Object} CommandHandle
 * @property {string|number} pid    — provider-specific process handle for kill()
 */

/**
 * @typedef {Object} FileEvent
 * @property {string} t      — ISO timestamp
 * @property {string} path
 * @property {'write'|'create'|'modify'|'delete'} type
 */

/**
 * @typedef {Object} SandboxMetrics
 * @property {number} cpuPct
 * @property {number} memMb
 * @property {number} [networkBytes]
 */

/**
 * @typedef {Object} SandboxAdapter
 * @property {(opts: { image: string, files?: SandboxFile[], env?: Record<string,string>, limits?: SandboxLimits }) => Promise<ProvisionResult>} provision
 * @property {(sandboxId: string, files: SandboxFile[]) => Promise<void>} uploadFiles
 * @property {(sandboxId: string, path: string) => Promise<string>} readFile
 * @property {(sandboxId: string, cmd: string, opts?: { timeoutMs?: number }) => Promise<CommandResult>} runCommand
 * @property {(sandboxId: string, cmd: string) => Promise<CommandHandle>} startBackgroundCommand
 * @property {(sandboxId: string, pid: string|number) => Promise<void>} killCommand
 * @property {(sandboxId: string, onEvent: (e: FileEvent) => void) => Promise<() => Promise<void>>} watchFileEvents
 * @property {(sandboxId: string) => Promise<SandboxMetrics>} getMetrics
 * @property {(sandboxId: string) => Promise<boolean>} isAlive
 * @property {(sandboxId: string) => Promise<void>} destroy
 */

const REQUIRED_METHODS = [
  'provision',
  'uploadFiles',
  'readFile',
  'runCommand',
  'startBackgroundCommand',
  'killCommand',
  'watchFileEvents',
  'getMetrics',
  'isAlive',
  'destroy',
];

/**
 * Throws if `adapter` is missing any required method. Used by
 * `adapterFactory.js` to fail fast if someone half-implements an adapter.
 *
 * @param {unknown} adapter
 * @param {string} name
 * @returns {void}
 */
function assertAdapter(adapter, name) {
  if (!adapter || typeof adapter !== 'object') {
    throw new Error(`Sandbox adapter "${name}" must be an object`);
  }
  const missing = REQUIRED_METHODS.filter((m) => typeof adapter[m] !== 'function');
  if (missing.length > 0) {
    throw new Error(`Sandbox adapter "${name}" missing methods: ${missing.join(', ')}`);
  }
}

module.exports = { assertAdapter, REQUIRED_METHODS };
