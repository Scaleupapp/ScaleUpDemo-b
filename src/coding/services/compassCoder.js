'use strict';

const { llmCall } = require('./llmRouter');
const tools = require('./compassCoderTools');
const budget = require('./coderBudget');
const recordingService = require('./recordingService');
const costTracker = require('./costTracker');

/**
 * Compass-as-Coder — pair-programmer surface for Refactor drills (Phase A)
 * and Capstone sessions (Phase B).
 *
 * Two entry points:
 *   - chat()        conversational only, no tools. Phase A refactor drills
 *                   run on the learner's laptop with no sandbox.
 *   - turn()        tool-use loop scoped to a capstone session sandbox.
 *                   The model can read/write files, run commands, run tests.
 *                   Daily token budget enforced per spec §10.
 *
 * Per WS4 the AI-pair-effectiveness signal depends on every turn landing
 * in the recording stream as a `compass_turn` event. resolveTurn() emits
 * the resolution (accept/edit/reject) when the learner closes the loop.
 */

// ── System prompts ───────────────────────────────────────────────────────────

const CHAT_SYSTEM = `You are Compass-as-Coder, helping a ScaleUp learner practice AI-augmented coding.

Your role is pair-programmer, NOT autopilot:
- Be specific. Vague answers help nobody.
- When you propose code, name what could go wrong and what to verify.
- Don't just do — explain WHY so the learner builds judgment.
- If the learner asks you to do something risky (modify tests, skip a step, blindly trust an output), push back.
- Surface assumptions you're making. The learner should be able to disagree.

Context-aware: the learner is mid-drill or mid-capstone. Stay focused on the current task; don't drift into tutorials unless asked.

When the learner submits code, you may suggest one targeted improvement. Don't dump rewrites — let them iterate.`;

const SESSION_SYSTEM = `${CHAT_SYSTEM}

You have these tools available, scoped to the learner's sandbox workspace:
- read_file(path)            — read a workspace file
- write_file(path, content)  — overwrite a workspace file (ONLY when the learner explicitly says 'apply')
- run_command(cmd)           — shell in the workspace
- run_tests(names?)          — run visible tests, optionally a subset

Default to chat. Reach for tools only when needed:
- Use read_file when you need to see code before suggesting changes.
- Use run_tests after a change to verify before recommending acceptance.
- Use run_command for ad-hoc inspection (e.g. listing files, checking dep versions).
- Use write_file ONLY when the learner has explicitly approved the change in chat. Never write a file proactively.

Each tool call costs the learner tokens against their daily budget. Don't loop unnecessarily.`;

// ── Conversational (no-tool) chat — Phase A entry point ─────────────────────

/**
 * Conversational turn — no tools. Used by Phase A refactor drills.
 *
 * @param {object} opts
 * @param {string} opts.user_id
 * @param {object} [opts.session_context] — { brief, language, drill_subtype, current_files }
 * @param {Array}  opts.message_history
 * @param {number} [opts.max_tokens=2048]
 * @returns {Promise<{ reply: string, model: string, usage: object, capped: boolean }>}
 */
async function chat({ user_id, session_context, message_history, max_tokens = 2048 } = {}) {
  if (!user_id) throw new Error('user_id required');
  if (!Array.isArray(message_history) || message_history.length === 0) {
    throw new Error('message_history required');
  }

  const estimated = estimateTokens(message_history) + max_tokens;
  const reservation = await budget.reserve(user_id, estimated);
  if (!reservation.ok) {
    return capped(reservation);
  }

  let result;
  try {
    result = await llmCall({
      taskId: 'compass_coder',
      system: buildChatSystem(session_context),
      messages: normalizeMessages(message_history),
    });
  } catch (err) {
    await budget.refund(user_id, estimated);
    await costTracker
      .recordSpend({
        result: { _meta: { taskId: 'compass_coder', provider: 'anthropic' } },
        taskId: 'compass_coder',
        actor: { userId: user_id },
        outcome: 'error',
        errorClass: err.constructor?.name || 'Error',
      })
      .catch(() => {});
    throw err;
  }

  const actual = (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);
  await budget.reconcile(user_id, actual, estimated);
  await costTracker
    .recordSpend({ result, taskId: 'compass_coder', actor: { userId: user_id } })
    .catch(() => {});

  return {
    reply: extractText(result.content),
    model: result._meta?.model,
    usage: result.usage,
    capped: false,
  };
}

// ── Session tool-use loop — Phase B entry point ─────────────────────────────

const MAX_TOOL_ITERATIONS = 8;

/**
 * Session-scoped turn with tool use. Loops until stop_reason='end_turn'
 * or MAX_TOOL_ITERATIONS (defensive cap so a runaway tool chain can't
 * burn budget unbounded).
 *
 * Returns the assistant's final text + full trace of tool calls + a
 * `prompt_id` the client uses when reporting accept/edit/reject via
 * resolveTurn().
 */
async function turn({ user_id, session_id, message_history, max_tokens = 2048 } = {}) {
  if (!user_id) throw new Error('user_id required');
  if (!session_id) throw new Error('session_id required');
  if (!Array.isArray(message_history) || message_history.length === 0) {
    throw new Error('message_history required');
  }

  // Verify ownership + sandbox aliveness up-front. ToolAuthError → 403.
  const ctx = await tools.resolveSessionContext(session_id, user_id);

  const estimated = estimateTokens(message_history) + max_tokens * 2;
  const reservation = await budget.reserve(user_id, estimated);
  if (!reservation.ok) {
    return { ...capped(reservation), tool_calls: [], prompt_id: null };
  }

  const messages = normalizeMessages(message_history);
  const traceCalls = [];
  let totalIn = 0;
  let totalOut = 0;
  let lastResult = null;
  let stopReason = null;
  const promptId = `coder-${session_id}-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;

  try {
    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      const result = await llmCall({
        taskId: 'compass_coder',
        system: buildSessionSystem(ctx.bundle),
        messages,
        tools: tools.TOOLS,
      });
      lastResult = result;
      totalIn += result.usage?.input_tokens || 0;
      totalOut += result.usage?.output_tokens || 0;
      stopReason = result.stop_reason;

      messages.push({ role: 'assistant', content: result.content });
      if (stopReason !== 'tool_use') break;

      const toolUseBlocks = (result.content || []).filter((b) => b.type === 'tool_use');
      const toolResults = [];
      for (const block of toolUseBlocks) {
        const r = await tools.dispatch({
          sessionId: session_id,
          userId: user_id,
          call: { name: block.name, input: block.input },
        });
        traceCalls.push({ tool: block.name, input: block.input, output: r.output, ok: r.ok });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: r.output,
          is_error: !r.ok,
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }
  } catch (err) {
    await budget.refund(user_id, estimated);
    await costTracker
      .recordSpend({
        result: { _meta: { taskId: 'compass_coder', provider: 'anthropic' } },
        taskId: 'compass_coder',
        actor: { userId: user_id, sessionId: session_id },
        outcome: 'error',
        errorClass: err.constructor?.name || 'Error',
      })
      .catch(() => {});
    throw err;
  }

  const totalActual = totalIn + totalOut;
  await budget.reconcile(user_id, totalActual, estimated);
  await costTracker
    .recordSpend({
      result: {
        usage: { input_tokens: totalIn, output_tokens: totalOut },
        _meta: lastResult?._meta || { taskId: 'compass_coder', provider: 'anthropic' },
      },
      taskId: 'compass_coder',
      actor: { userId: user_id, sessionId: session_id },
    })
    .catch(() => {});

  // Emit compass_turn for the evaluator. resolution stays 'pending' until
  // resolveTurn() is called by the client.
  recordingService.emit(session_id, {
    type: 'compass_turn',
    payload: {
      prompt_id: promptId,
      tool_count: traceCalls.length,
      tokens_in: totalIn,
      tokens_out: totalOut,
      resolution: 'pending',
    },
  });

  return {
    reply: extractText(lastResult?.content),
    model: lastResult?._meta?.model,
    tool_calls: traceCalls,
    prompt_id: promptId,
    capped: false,
    usage: { input_tokens: totalIn, output_tokens: totalOut },
  };
}

/**
 * Report the learner's resolution (accept / edit / reject) of a prior
 * turn. Emits a follow-up `compass_turn` event so the WS4 evaluator's
 * resolution-ratio signal is accurate.
 */
async function resolveTurn({ session_id, prompt_id, resolution } = {}) {
  if (!session_id || !prompt_id) throw new Error('session_id and prompt_id required');
  if (!['accept', 'edit', 'reject'].includes(resolution)) {
    throw new Error("resolution must be 'accept' | 'edit' | 'reject'");
  }
  recordingService.emit(session_id, {
    type: 'compass_turn',
    payload: { prompt_id, resolution, resolved_at: new Date().toISOString() },
  });
}

// ── helpers ──────────────────────────────────────────────────────────────────

function buildChatSystem(sessionContext) {
  if (!sessionContext) return CHAT_SYSTEM;
  const parts = [];
  if (sessionContext.brief) parts.push(`CURRENT TASK BRIEF:\n${sessionContext.brief}`);
  if (sessionContext.language) parts.push(`LANGUAGE: ${sessionContext.language}`);
  if (sessionContext.drill_subtype) parts.push(`DRILL TYPE: ${sessionContext.drill_subtype}`);
  if (sessionContext.current_files?.length) {
    parts.push(`CURRENT FILE STATE:\n${JSON.stringify(sessionContext.current_files, null, 2)}`);
  }
  if (parts.length === 0) return CHAT_SYSTEM;
  return `${CHAT_SYSTEM}\n\n--- SESSION CONTEXT ---\n${parts.join('\n\n')}`;
}

function buildSessionSystem(bundle) {
  const ctx = [
    `BUNDLE BRIEF:\n${bundle.brief}`,
    `LANGUAGE: ${bundle.language}${bundle.stack_variant ? ` · stack ${bundle.stack_variant}` : ''}`,
    `DIFFICULTY: ${bundle.difficulty}`,
    `ACCEPTANCE CRITERIA:\n${(bundle.acceptance_criteria || []).map((c) => `- ${c}`).join('\n')}`,
  ].join('\n\n');
  return `${SESSION_SYSTEM}\n\n--- SESSION CONTEXT ---\n${ctx}`;
}

function normalizeMessages(history) {
  return history.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));
}

function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text' || typeof b.text === 'string')
    .map((b) => b.text || '')
    .join('\n');
}

function estimateTokens(messageHistory) {
  // Cheap heuristic: ~4 chars per token. Over-estimate slightly so the
  // budget reservation doesn't false-allow turns that would push the
  // user over cap.
  const totalChars = messageHistory.reduce((s, m) => {
    if (typeof m.content === 'string') return s + m.content.length;
    if (Array.isArray(m.content)) return s + JSON.stringify(m.content).length;
    return s;
  }, 0);
  return Math.ceil(totalChars / 4);
}

function capped(reservation) {
  return {
    reply: `Your daily Compass-Coder budget is reached (${reservation.used}/${reservation.cap} tokens used). Resets at 00:00 UTC.`,
    model: null,
    usage: { input_tokens: 0, output_tokens: 0 },
    capped: true,
  };
}

module.exports = {
  chat,
  turn,
  resolveTurn,
  // back-compat with Phase A refactor flow
  buildSystemPrompt: buildChatSystem,
  CODER_SYSTEM_PROMPT: CHAT_SYSTEM,
  MAX_TOOL_ITERATIONS,
};
