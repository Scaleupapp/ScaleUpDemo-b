'use strict';

/**
 * LLM Router — maps each coding task ID to the right provider + model.
 *
 * Usage:
 *   const { getModelForTask, getRoutingTable, llmCall } = require('./llmRouter');
 */

const anthropic = require('../integrations/anthropic.client');
const gemini    = require('../integrations/gemini.client');

// ── Routing table ─────────────────────────────────────────────────────────────

// NOTE: these tasks do NOT declare provider tools. We used to pass
// `tools: ['code_execution']`, but (a) both the Anthropic and Gemini APIs
// require tool entries to be objects, not bare strings — a string array is
// rejected with `tools.0: Input should be an object` (400), which broke EVERY
// generation/validation call — and (b) the consumers only ever read the final
// text block and JSON.parse it (see contentGenerator.extractJson), so any
// tool_use output was discarded anyway. Code is actually proven by the external
// sandbox proof in contentValidator, not by a model-side execution tool.
const ROUTING_TABLE = {
  content_generator_draft:   { provider: 'anthropic', model: 'claude-opus-4-7' },
  content_validator_cross:   { provider: 'google',    model: 'gemini-2.5-pro' },
  capstone_quality_cross:    { provider: 'google',    model: 'gemini-2.5-pro' },
  reference_solution_solver: { provider: 'anthropic', model: 'claude-opus-4-7' },
  drill_grade_prompt:        { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
  drill_grade_verify:        { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
  drill_grade_decompose:     { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
  drill_grade_refactor:      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  capstone_evaluator:        { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  seeded_mistake_generator:  { provider: 'anthropic', model: 'claude-opus-4-7' },
  hidden_test_generator:     { provider: 'google',    model: 'gemini-2.5-pro' },
  compass_coder:             { provider: 'anthropic', model: 'claude-sonnet-4-6' },
};

// ── Public helpers ────────────────────────────────────────────────────────────

/**
 * Returns a shallow copy of the full routing table.
 * @returns {object}
 */
function getRoutingTable() {
  return { ...ROUTING_TABLE };
}

/**
 * Looks up the routing entry for a task ID.
 * Throws if the task ID is not registered.
 *
 * @param {string} taskId
 * @returns {{ provider: string, model: string, tools?: string[] }}
 */
function getModelForTask(taskId) {
  const entry = ROUTING_TABLE[taskId];
  if (!entry) {
    throw new Error(`Unknown LLM task ID: "${taskId}". Register it in ROUTING_TABLE.`);
  }
  return entry;
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

/**
 * Routes a request to the appropriate LLM provider and returns a normalised response.
 *
 * @param {object} opts
 * @param {string}   opts.taskId     — one of the registered task IDs
 * @param {string}  [opts.system]    — system prompt
 * @param {Array}   [opts.messages]  — message array (Anthropic format)
 * @param {string}  [opts.prompt]    — plain-text prompt (Gemini fallback)
 * @param {Array}   [opts.tools]     — extra tools to merge with the routing-table defaults
 * @returns {Promise<{content, usage, _meta: {taskId, provider, model, duration_ms}}>}
 */
async function llmCall({ taskId, system, messages, prompt, tools: extraTools }) {
  const { provider, model, tools: defaultTools = [] } = getModelForTask(taskId);
  const tools = [...defaultTools, ...(extraTools || [])];

  const started = Date.now();
  let result;

  if (provider === 'anthropic') {
    result = await anthropic.call({ model, system, messages, tools });
  } else if (provider === 'google') {
    result = await gemini.call({ model, system, prompt: prompt || messages, tools });
  } else {
    throw new Error(`Unsupported provider: "${provider}"`);
  }

  const duration_ms = Date.now() - started;
  return { ...result, _meta: { taskId, provider, model, duration_ms } };
}

module.exports = { getRoutingTable, getModelForTask, llmCall };
