'use strict';

/**
 * Compass WRITE-proposal tools (agent #2, Compass Actions).
 *
 * Contract: these tools NEVER mutate state. A tool call records a PENDING
 * AgentDecision and emits an `agent_proposal` card; the change is applied only
 * when the user confirms via POST /api/v2/agent/decisions/:id/respond. The
 * confirm card is deliberate — it is also the feedback-labeling mechanism
 * that trains every future version of this agent.
 *
 * Ops are a strict whitelist shared with agentDecisionService.applyPlanOps
 * via ./agentPlanOps (the single source of truth for both).
 */

const agentDecisionService = require('../agentDecisionService');
const { OPS, STATUSES } = require('../agentPlanOps');

const MAX_OPS = 5;

const PROPOSAL_TOOLS = [
  {
    name: 'propose_plan_update',
    description:
      "Propose changes to the learner's plan when they ask to rearrange, lighten, or catch up on their week. " +
      'The proposal is NOT applied — the learner sees a card and must confirm. ' +
      'Keep proposals small (1–5 ops), give a human title, and always state the consequence for their readiness trajectory. ' +
      "Supported ops: set_task_status (skip / complete / restore one task by taskId — taskIds appear in the learner context), reset_skipped (restore every skipped task).",
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short human title, e.g. "Protect exam week"' },
        summary: { type: 'string', description: 'One sentence on what changes' },
        consequence: { type: 'string', description: 'Effect on the readiness projection' },
        ops: {
          type: 'array',
          maxItems: MAX_OPS,
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: OPS },
              taskId: { type: 'string' },
              status: { type: 'string', enum: STATUSES },
            },
            required: ['op'],
          },
        },
      },
      required: ['title', 'ops'],
    },
  },
];

const NAMES = new Set(PROPOSAL_TOOLS.map((t) => t.name));

function isProposalTool(name) {
  return NAMES.has(name);
}

function validateInput(input) {
  if (!input || typeof input.title !== 'string' || !input.title.trim()) return 'title is required';
  if (!Array.isArray(input.ops) || input.ops.length === 0) return 'ops must be a non-empty array';
  if (input.ops.length > MAX_OPS) return `ops must not exceed ${MAX_OPS} items`;
  for (const op of input.ops) {
    if (!op || !OPS.includes(op.op)) return `unsupported op: ${op && op.op}`;
    if (op.op === 'set_task_status') {
      if (!op.taskId) return 'set_task_status requires taskId';
      if (!STATUSES.includes(op.status)) return `unsupported status: ${op.status}`;
    }
  }
  return null;
}

async function dispatch({ userId, name, input = {}, meta = {} }, deps = {}) {
  const recordFn = deps.record || agentDecisionService.record;
  try {
    if (name !== 'propose_plan_update') {
      return { ok: false, output: JSON.stringify({ error: `unknown tool ${name}` }), card: null };
    }
    const problem = validateInput(input);
    if (problem) {
      return { ok: false, output: JSON.stringify({ error: problem }), card: null };
    }
    const decision = await recordFn({
      agentId: 'compass_actions',
      decisionType: 'proposal',
      userId,
      action: {
        title: input.title,
        summary: input.summary || null,
        consequence: input.consequence || null,
        ops: input.ops,
      },
      promptVersion: meta.promptVersion,
      modelId: meta.modelId,
    });
    const payload = {
      decisionId: String(decision._id),
      title: input.title,
      summary: input.summary || null,
      consequence: input.consequence || null,
      ops: input.ops,
    };
    return {
      ok: true,
      output: JSON.stringify({
        proposed: true,
        decisionId: payload.decisionId,
        note: 'Proposal shown to the learner as a card. It is NOT applied until they confirm — tell them to review it.',
      }),
      card: { type: 'agent_proposal', payload },
    };
  } catch (err) {
    console.warn('[compassProposalTools] dispatch failed', name, err.message);
    return { ok: false, output: JSON.stringify({ error: 'could not create that proposal right now' }), card: null };
  }
}

module.exports = { PROPOSAL_TOOLS, isProposalTool, dispatch };
