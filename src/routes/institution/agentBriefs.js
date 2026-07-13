'use strict';

/**
 * Intervention brief + activation endpoints (agentic layer, Plan 4, Task 3).
 *
 * GET  /agent/briefs             — latest intervention 'brief' rows for the
 *                                   caller's institution, shaped for the TPO
 *                                   briefs UI (cluster summaries only).
 * POST /agent/briefs/:id/approve — tpo_head-only (checker semantics: a
 *                                   coordinator can VIEW a brief but only the
 *                                   head can fire notifications off it).
 *                                   Delegates to briefApprovalService.
 * GET  /agent/activation         — read-only funnel snapshot from
 *                                   activationAgentService.getFunnel.
 *
 * Flag-off returns 404 (house convention — see src/routes/v2/agentDecisions.js):
 * briefs endpoints gate on the 'intervention' flag, activation on 'activation'.
 */
const express = require('express');
const institutionAuth = require('../../middleware/institutionAuth');
const { institutionScope, requireInstitutionRole } = require('../../middleware/institutionScope');
const briefApprovalService = require('../../services/institution/briefApprovalService');
const activationAgentService = require('../../services/institution/activationAgentService');
const { isAgentEnabled } = require('../../config/agentFlags');

const MAX_BRIEFS = 10;

function shapeCluster(cluster) {
  return {
    key: cluster.key,
    label: cluster.label,
    count: Array.isArray(cluster.studentIds) ? cluster.studentIds.length : 0,
    evidence: cluster.evidence,
    proposedAction: cluster.proposedAction,
  };
}

function shapeBrief(row) {
  const action = row.action || {};
  return {
    id: String(row._id),
    cohortId: row.cohortId ? String(row.cohortId) : null,
    cohortLabel: action.cohortLabel || null,
    createdAt: row.createdAt,
    status: row.status,
    clusters: Array.isArray(action.clusters) ? action.clusters.map(shapeCluster) : [],
  };
}

/**
 * Handler factory with DI seams (repo test convention: zero DB in tests).
 */
function makeHandlers(deps = {}) {
  const d = {
    isAgentEnabled: deps.isAgentEnabled || isAgentEnabled,
    AgentDecision: deps.AgentDecision || require('../../models/AgentDecision'),
    approveBrief: deps.approveBrief || briefApprovalService.approveBrief,
    getFunnel: deps.getFunnel || activationAgentService.getFunnel,
  };

  async function listBriefsHandler(req, res) {
    try {
      if (!d.isAgentEnabled('intervention')) {
        return res.status(404).json({ success: false, message: 'Not found' });
      }
      const scope = institutionScope(req);
      const query = { agentId: 'intervention', institutionId: scope.institutionId };
      const { cohortId } = req.query || {};
      if (cohortId) query.cohortId = cohortId;

      const rows = await d.AgentDecision.find(query).sort({ createdAt: -1 }).limit(MAX_BRIEFS);
      return res.json({ success: true, data: { decisions: (rows || []).map(shapeBrief) } });
    } catch (err) {
      console.error('[institution/agent-briefs] list error', err);
      return res.status(500).json({ success: false, message: 'Could not load briefs.' });
    }
  }

  async function approveBriefHandler(req, res) {
    try {
      if (!d.isAgentEnabled('intervention')) {
        return res.status(404).json({ success: false, message: 'Not found' });
      }
      const { clusterKeys } = req.body || {};
      if (!Array.isArray(clusterKeys) || clusterKeys.length === 0) {
        return res.status(400).json({ success: false, message: 'clusterKeys is required' });
      }

      const scope = institutionScope(req);
      const result = await d.approveBrief({
        decisionId: req.params.decisionId,
        institutionId: scope.institutionId,
        actorInstitutionUserId: req.institution.institutionUserId,
        clusterKeys,
      });
      return res.json({ success: true, data: result });
    } catch (err) {
      // Order matters: unsupported-* messages interpolate a caller-controlled
      // clusterKey that could contain "not found" or "already" — check the
      // anchored, caller-independent prefix first so those can't mis-map to
      // 404/409.
      if (/^unsupported/i.test(err.message)) return res.status(400).json({ success: false, message: err.message });
      if (/not found/i.test(err.message)) return res.status(404).json({ success: false, message: 'Brief not found' });
      if (/already/i.test(err.message)) return res.status(409).json({ success: false, message: err.message });
      console.error('[institution/agent-briefs] approve error', err);
      return res.status(500).json({ success: false, message: 'Could not approve the brief.' });
    }
  }

  async function getActivationHandler(req, res) {
    try {
      if (!d.isAgentEnabled('activation')) {
        return res.status(404).json({ success: false, message: 'Not found' });
      }
      const { cohortId } = req.query || {};
      if (!cohortId) {
        return res.status(400).json({ success: false, message: 'cohortId is required' });
      }

      const scope = institutionScope(req);
      const funnel = await d.getFunnel({ institutionId: scope.institutionId, cohortId });
      return res.json({ success: true, data: funnel });
    } catch (err) {
      console.error('[institution/agent-briefs] activation error', err);
      return res.status(500).json({ success: false, message: 'Could not load the activation funnel.' });
    }
  }

  return { listBriefsHandler, approveBriefHandler, getActivationHandler };
}

const router = express.Router();
const handlers = makeHandlers();
router.get(
  '/agent/briefs',
  institutionAuth,
  requireInstitutionRole('tpo_head', 'tpo_coordinator'),
  handlers.listBriefsHandler
);
router.post(
  '/agent/briefs/:decisionId/approve',
  institutionAuth,
  requireInstitutionRole('tpo_head'),
  handlers.approveBriefHandler
);
router.get(
  '/agent/activation',
  institutionAuth,
  requireInstitutionRole('tpo_head', 'tpo_coordinator'),
  handlers.getActivationHandler
);

module.exports = router;
module.exports.makeHandlers = makeHandlers;
