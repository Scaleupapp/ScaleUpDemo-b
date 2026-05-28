'use strict';

const sandboxOrchestrator = require('./sandboxOrchestrator');
const recordingService = require('./recordingService');
const CapstoneSession = require('../models/capstoneSession.model');
const ArtifactBundle = require('../models/artifactBundle.model');

/**
 * Compass-Coder tool catalogue + dispatcher.
 *
 * Each tool runs server-side, scoped to a specific capstone session's
 * sandbox. The model proposes a tool_use block; we execute it against the
 * orchestrator; we surface results back to the model in a tool_result
 * block. Every tool call is emitted to the recording stream so the
 * evaluator's AI-pair-effectiveness signal sees the real coder behavior.
 *
 * Path constraints — all tool paths are normalized to a sandbox-relative
 * form and rejected if they escape the workspace. We don't trust the LLM
 * to play nicely.
 */

const WORKSPACE_ROOT = '/home/user';
const MAX_PATH_LEN = 256;
const MAX_FILE_BYTES = 256 * 1024; // 256 KB per write/read

const TOOLS = [
  {
    name: 'read_file',
    description: "Read a file from the learner's workspace. Use this when you need to know what's currently in a file before suggesting changes. Path is workspace-relative (e.g. 'src/index.js').",
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'workspace-relative path' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: "Write or overwrite a file in the learner's workspace. Use sparingly — propose changes in chat first and let the learner accept. When the learner explicitly says 'apply', use this. Path is workspace-relative.",
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string', description: 'full file content (overwrite)' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command in the workspace. Useful for checking the current state, listing files, running ad-hoc scripts. Avoid destructive commands.',
    input_schema: {
      type: 'object',
      properties: {
        cmd: { type: 'string' },
      },
      required: ['cmd'],
    },
  },
  {
    name: 'run_tests',
    description: 'Run the bundle\'s visible_tests (or a named subset). Use this to verify a change before recommending the learner accept it.',
    input_schema: {
      type: 'object',
      properties: {
        names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional subset of test names from bundle.visible_tests. Omit to run all.',
        },
      },
    },
  },
];

class ToolAuthError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'ToolAuthError';
  }
}

/**
 * Normalize + validate a workspace-relative path. Throws if it escapes.
 */
function safePath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new ToolAuthError('path required');
  }
  if (rawPath.length > MAX_PATH_LEN) {
    throw new ToolAuthError(`path exceeds ${MAX_PATH_LEN} chars`);
  }
  const stripped = rawPath.replace(/^\/+/, '');
  if (stripped.split('/').some((seg) => seg === '..' || seg === '')) {
    throw new ToolAuthError('path may not contain .. or empty segments');
  }
  return `${WORKSPACE_ROOT}/${stripped}`;
}

/**
 * Resolve the session + its bundle + sandbox handle. Throws if the
 * caller (userId) doesn't own the session or if it has no sandbox.
 *
 * @param {string} sessionId
 * @param {string} userId
 * @returns {Promise<{ session: object, bundle: object, sandboxId: string }>}
 */
async function resolveSessionContext(sessionId, userId) {
  const session = await CapstoneSession.findOne({ _id: sessionId, user_id: userId }).lean();
  if (!session) throw new ToolAuthError('session not found or not owned by caller');
  if (!session.sandbox_id) throw new ToolAuthError('session has no active sandbox');
  if (!['ready', 'in_progress', 'paused'].includes(session.status)) {
    throw new ToolAuthError(`session is ${session.status} — tools unavailable`);
  }
  const bundle = await ArtifactBundle.findById(session.bundle_id).lean();
  if (!bundle) throw new ToolAuthError('bundle not found');
  return { session, bundle, sandboxId: session.sandbox_id };
}

/**
 * Dispatch a single tool call. Returns the result payload that gets fed
 * back to the LLM as a tool_result block. Also emits a recording event
 * so the evaluator can score the AI-pair-effectiveness signal.
 *
 * @param {object} args
 * @param {string} args.sessionId
 * @param {string} args.userId
 * @param {{name: string, input: object}} args.call
 * @returns {Promise<{ ok: boolean, output: string }>}
 */
async function dispatch({ sessionId, userId, call }) {
  const { name, input } = call || {};
  const ctx = await resolveSessionContext(sessionId, userId);

  let output;
  let ok = true;
  try {
    switch (name) {
      case 'read_file': {
        const abs = safePath(input?.path);
        const adapter = sandboxOrchestrator._adapter;
        const content = await adapter.readFile(ctx.sandboxId, abs);
        if (content == null) {
          ok = false;
          output = 'file not found';
        } else if (Buffer.byteLength(content) > MAX_FILE_BYTES) {
          output = String(content).slice(0, MAX_FILE_BYTES) + '\n…(truncated)';
        } else {
          output = String(content);
        }
        recordingService.emit(sessionId, {
          type: 'file_read',
          payload: { path: input?.path, bytes: Buffer.byteLength(output || ''), by: 'compass_coder' },
        });
        break;
      }
      case 'write_file': {
        const abs = safePath(input?.path);
        if (typeof input?.content !== 'string') {
          throw new ToolAuthError('content must be a string');
        }
        if (Buffer.byteLength(input.content) > MAX_FILE_BYTES) {
          throw new ToolAuthError(`content exceeds ${MAX_FILE_BYTES} bytes`);
        }
        const adapter = sandboxOrchestrator._adapter;
        await adapter.uploadFiles(ctx.sandboxId, [{ path: abs, content: input.content }]);
        output = `wrote ${Buffer.byteLength(input.content)} bytes to ${input.path}`;
        recordingService.emit(sessionId, {
          type: 'file_write',
          payload: {
            path: input.path,
            bytes: Buffer.byteLength(input.content),
            by: 'compass_coder',
          },
        });
        break;
      }
      case 'run_command': {
        if (typeof input?.cmd !== 'string' || input.cmd.length === 0) {
          throw new ToolAuthError('cmd required');
        }
        if (input.cmd.length > 4096) throw new ToolAuthError('cmd too long');
        const r = await sandboxOrchestrator.runInSession(sessionId, input.cmd, {
          timeoutMs: 30_000,
        });
        output = JSON.stringify({
          exit: r.exitCode,
          stdout: (r.stdout || '').slice(0, 8_000),
          stderr: (r.stderr || '').slice(0, 4_000),
          duration_ms: r.durationMs,
        });
        recordingService.emit(sessionId, {
          type: 'command_run',
          payload: {
            cmd: input.cmd.slice(0, 256),
            exit: r.exitCode,
            duration_ms: r.durationMs,
            by: 'compass_coder',
          },
        });
        break;
      }
      case 'run_tests': {
        const requested = Array.isArray(input?.names) ? input.names : null;
        const tests = (ctx.bundle.visible_tests || []).filter(
          (t) => !requested || requested.includes(t.name)
        );
        const results = [];
        for (const t of tests) {
          const r = await sandboxOrchestrator
            .runInSession(sessionId, t.command, { timeoutMs: 60_000 })
            .catch((err) => ({
              exitCode: -1,
              stdout: '',
              stderr: String(err.message || err),
              durationMs: 0,
            }));
          const passed = r.exitCode === 0;
          results.push({
            name: t.name,
            passed,
            exit: r.exitCode,
            stderr: (r.stderr || '').slice(0, 1_000),
            duration_ms: r.durationMs,
          });
          recordingService.emit(sessionId, {
            type: 'test_result',
            payload: { name: t.name, passed, duration_ms: r.durationMs, by: 'compass_coder' },
          });
        }
        output = JSON.stringify({
          ran: results.length,
          passed: results.filter((r) => r.passed).length,
          results,
        });
        break;
      }
      default:
        throw new ToolAuthError(`unknown tool: ${name}`);
    }
  } catch (err) {
    ok = false;
    output = String(err.message || err);
    if (!(err instanceof ToolAuthError)) {
      // eslint-disable-next-line no-console
      console.warn(`[compassCoderTools] ${name} failed:`, err.message);
    }
  }

  return { ok, output };
}

module.exports = {
  TOOLS,
  dispatch,
  resolveSessionContext,
  ToolAuthError,
  WORKSPACE_ROOT,
};
