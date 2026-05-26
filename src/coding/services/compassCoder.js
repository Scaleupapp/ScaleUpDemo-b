'use strict';

/**
 * Compass Coder mode — AI pair-programmer surface for coding drills.
 *
 * Used inside Refactor drills (Phase A) and Capstone (Phase B). Runs
 * Claude Sonnet 4.6 via the coding llmRouter (taskId: 'compass_coder').
 *
 * Scenario B: standalone service in src/coding/services/.
 * Coding-feature routes call this directly; it is NOT wired through the
 * main Compass orchestrator (src/services/v2/compassOrchestrator.js) because
 * that orchestrator manages its own direct Anthropic client + Redis token
 * budget. Keeping coder mode separate avoids coupling the coding pipeline to
 * the Compass budget system and the v2 user-context graph.
 *
 * The compassOrchestrator mode enum comment has been updated to note 'coder'
 * lives here (Scenario B).
 *
 * Entry point:
 *   chat({ user_id, session_context, message_history, max_tokens? })
 *     → { reply: string, model: string|undefined, usage: object|undefined }
 */

const { llmCall } = require('./llmRouter');

// ── System prompt ─────────────────────────────────────────────────────────────

const CODER_SYSTEM_PROMPT = `You are Compass-as-Coder, helping a ScaleUp learner practice AI-augmented coding.

Your role is pair-programmer, NOT autopilot:
- Be specific. Vague answers help nobody.
- When you propose code, name what could go wrong and what to verify.
- Don't just do — explain WHY so the learner builds judgment.
- If the learner asks you to do something risky (modify tests, skip a step, blindly trust an output), push back.
- Surface assumptions you're making. The learner should be able to disagree.

Context-aware: the learner is mid-drill or mid-capstone. Stay focused on the current task; don't drift into tutorials unless asked.

When the learner submits code, you may suggest one targeted improvement. Don't dump rewrites — let them iterate.`;

// ── Session context injection ─────────────────────────────────────────────────

/**
 * Build the full system prompt, optionally injecting session context.
 *
 * @param {object|null} sessionContext — may contain:
 *   { bundle_id, drill_subtype, language, role_track, brief,
 *     current_files: [{ path, content }], recent_actions }
 * @returns {string}
 */
function buildSystemPrompt(sessionContext) {
  if (!sessionContext) return CODER_SYSTEM_PROMPT;

  const ctxParts = [];
  if (sessionContext.brief)         ctxParts.push(`CURRENT TASK BRIEF:\n${sessionContext.brief}`);
  if (sessionContext.language)      ctxParts.push(`LANGUAGE: ${sessionContext.language}`);
  if (sessionContext.drill_subtype) ctxParts.push(`DRILL TYPE: ${sessionContext.drill_subtype}`);
  if (sessionContext.current_files && sessionContext.current_files.length > 0) {
    ctxParts.push(`CURRENT FILE STATE:\n${JSON.stringify(sessionContext.current_files, null, 2)}`);
  }

  if (ctxParts.length === 0) return CODER_SYSTEM_PROMPT;
  return `${CODER_SYSTEM_PROMPT}\n\n--- SESSION CONTEXT ---\n${ctxParts.join('\n\n')}`;
}

// ── Main entry ────────────────────────────────────────────────────────────────

/**
 * Send one conversational turn to Compass Coder.
 *
 * @param {object} opts
 * @param {string}  opts.user_id        — required; used for logging / future budgeting
 * @param {object}  [opts.session_context] — optional drill context (see buildSystemPrompt)
 * @param {Array}   opts.message_history  — non-empty array of { role, content } objects
 * @param {number}  [opts.max_tokens=2048]
 *
 * @returns {Promise<{ reply: string, model: string|undefined, usage: object|undefined }>}
 */
async function chat({ user_id, session_context, message_history, max_tokens = 2048 }) {
  if (!user_id) throw new Error('user_id required');
  if (!Array.isArray(message_history) || message_history.length === 0) {
    throw new Error('message_history required (non-empty array)');
  }

  const system = buildSystemPrompt(session_context);

  const messages = message_history.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));

  const res = await llmCall({
    taskId: 'compass_coder',
    system,
    messages,
  });

  // Anthropic returns content: [{ type: 'text', text: '...' }]
  const textBlock = Array.isArray(res.content)
    ? res.content.find(c => c.type === 'text' || c.text)
    : null;
  const reply = textBlock ? textBlock.text : '';

  return {
    reply,
    model: res._meta && res._meta.model,
    usage: res.usage,
  };
}

module.exports = { chat, buildSystemPrompt, CODER_SYSTEM_PROMPT };
