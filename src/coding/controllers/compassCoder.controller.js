'use strict';

const compassCoder = require('../services/compassCoder');
const { ToolAuthError } = require('../services/compassCoderTools');
const budget = require('../services/coderBudget');

/**
 * Compass-Coder HTTP controllers. The conversational chat() entry point
 * is reachable from Phase A refactor drills; turn() is the Phase B
 * tool-use surface scoped to a capstone session.
 *
 * Both go through the same daily budget service so the cap applies
 * uniformly across drill + capstone.
 */

/** POST /api/coding/compass-coder/chat — Phase A refactor drill chat */
async function chat(req, res) {
  const { session_context, message_history, max_tokens } = req.body || {};
  if (!Array.isArray(message_history) || message_history.length === 0) {
    return res.status(400).json({ error: 'message_history required (non-empty array)' });
  }
  try {
    const result = await compassCoder.chat({
      user_id: req.user.userId,
      session_context,
      message_history,
      max_tokens,
    });
    res.json(result);
  } catch (err) {
    if (err instanceof ToolAuthError) return res.status(403).json({ error: err.message });
    throw err;
  }
}

/** POST /api/coding/compass-coder/turn — Phase B capstone tool-use turn */
async function turn(req, res) {
  const { session_id, message_history, max_tokens } = req.body || {};
  if (!session_id) return res.status(400).json({ error: 'session_id required' });
  if (!Array.isArray(message_history) || message_history.length === 0) {
    return res.status(400).json({ error: 'message_history required (non-empty array)' });
  }
  try {
    const result = await compassCoder.turn({
      user_id: req.user.userId,
      session_id,
      message_history,
      max_tokens,
    });
    res.json(result);
  } catch (err) {
    if (err instanceof ToolAuthError) return res.status(403).json({ error: err.message });
    throw err;
  }
}

/**
 * POST /api/coding/compass-coder/resolve — client reports learner accept /
 * edit / reject for a prior turn. Emits a compass_turn event with the
 * resolution so the WS4 evaluator's AI-pair-effectiveness signal is
 * accurate.
 */
async function resolve(req, res) {
  const { session_id, prompt_id, resolution } = req.body || {};
  try {
    await compassCoder.resolveTurn({ session_id, prompt_id, resolution });
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

/** GET /api/coding/compass-coder/budget — current usage snapshot */
async function getBudget(req, res) {
  const usage = await budget.getUsage(req.user.userId);
  res.json(usage);
}

module.exports = { chat, turn, resolve, getBudget };
