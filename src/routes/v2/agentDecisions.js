'use strict';

/**
 * Agent decision feedback endpoints (agentic layer, Plan 1).
 *
 * The respond endpoint is the labeling machine for the whole agentic layer:
 * every Apply / Adjust / Dismiss lands here and closes an AgentDecision row.
 * Flag-off returns 404 (house convention: clients treat 404 as feature-off).
 */
const express = require('express');
const auth = require('../../middleware/auth');
const agentDecisionService = require('../../services/agentDecisionService');
const { isAgentEnabled } = require('../../config/agentFlags');

function defaultListForUser(userId, status) {
  const AgentDecision = require('../../models/AgentDecision');
  const filter = { userId };
  if (status) filter.status = status;
  return AgentDecision.find(filter).sort({ createdAt: -1 }).limit(20).lean();
}

/**
 * Handler factory with DI seams (repo test convention: zero DB in tests).
 */
function makeHandlers(deps = {}) {
  const d = {
    isAgentEnabled: deps.isAgentEnabled || isAgentEnabled,
    respond: deps.respond || agentDecisionService.respond,
    listForUser: deps.listForUser || defaultListForUser,
  };

  async function respondHandler(req, res) {
    try {
      if (!d.isAgentEnabled('compass_actions')) {
        return res.status(404).json({ success: false, message: 'Not found' });
      }
      const { response, adjustedOps } = req.body || {};
      const { decision, applied } = await d.respond({
        decisionId: req.params.id,
        userId: req.user.userId,
        response,
        adjustedOps,
      });
      return res.json({ success: true, data: { decisionId: String(decision._id), status: decision.status, applied } });
    } catch (err) {
      if (/not found/i.test(err.message)) return res.status(404).json({ success: false, message: 'Decision not found' });
      if (/already/i.test(err.message)) return res.status(409).json({ success: false, message: err.message });
      if (/unsupported/i.test(err.message)) return res.status(400).json({ success: false, message: err.message });
      console.error('[v2/agent/decisions] respond error', err);
      return res.status(500).json({ success: false, message: 'Could not record your response' });
    }
  }

  async function listHandler(req, res) {
    try {
      if (!d.isAgentEnabled('compass_actions')) {
        return res.status(404).json({ success: false, message: 'Not found' });
      }
      const status = req.query.status ? String(req.query.status) : 'pending';
      const decisions = await d.listForUser(req.user.userId, status);
      return res.json({ success: true, data: { decisions } });
    } catch (err) {
      console.error('[v2/agent/decisions] list error', err);
      return res.status(500).json({ success: false, message: 'Could not load decisions' });
    }
  }

  return { respondHandler, listHandler };
}

const router = express.Router();
const handlers = makeHandlers();
router.get('/decisions', auth, handlers.listHandler);
router.post('/decisions/:id/respond', auth, handlers.respondHandler);

module.exports = router;
module.exports.makeHandlers = makeHandlers;
