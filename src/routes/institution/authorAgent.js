'use strict';

/**
 * Author-agent run endpoints (agentic layer, Plan 3, Task 2; made
 * engine-aware in Plan 7, Task 2).
 *
 * Kicks off authorAgentService's engine-aware generate -> QA -> (repair,
 * where applicable) run for ANY authorable assessment type — mcq, interview,
 * capstone, drill (startRun) — and exposes a polling endpoint for its run
 * status (getRunStatus). The route itself carries no engine-specific gate:
 * authorAgentService.startRun owns the full authorability guard (assessment
 * type + status); this route just scopes to the caller's institution and
 * maps the service's errors onto HTTP status codes. Flag-off returns 404
 * (house convention: clients treat 404 as feature-off — see
 * src/routes/v2/agentDecisions.js).
 */
const express = require('express');
const institutionAuth = require('../../middleware/institutionAuth');
const { institutionScope, requireInstitutionRole } = require('../../middleware/institutionScope');
const authorAgentService = require('../../services/institution/assessment/authorAgentService');
const { isAgentEnabled } = require('../../config/agentFlags');

/**
 * Handler factory with DI seams (repo test convention: zero DB in tests).
 */
function makeHandlers(deps = {}) {
  const d = {
    isAgentEnabled: deps.isAgentEnabled || isAgentEnabled,
    startRun: deps.startRun || authorAgentService.startRun,
    getRunStatus: deps.getRunStatus || authorAgentService.getRunStatus,
    Assessment: deps.Assessment || require('../../models/Assessment'),
  };

  async function startRunHandler(req, res) {
    try {
      if (!d.isAgentEnabled('author_agent')) {
        return res.status(404).json({ success: false, message: 'Not found' });
      }
      const { brief } = req.body || {};
      if (!brief || typeof brief !== 'string') {
        return res.status(400).json({ success: false, message: 'brief is required' });
      }

      const scope = institutionScope(req);
      // Minimal fetch for cohortId — startRun does its own full guard-fetch
      // (existence + institution ownership + authorable status); this is
      // just context to store on the decision row.
      const assessment = await d.Assessment.findById(req.params.id).select('institutionId cohortId');
      const cohortId = assessment ? assessment.cohortId : undefined;

      const { decisionId } = await d.startRun({
        assessmentId: req.params.id,
        institutionId: scope.institutionId,
        cohortId,
        actorInstitutionUserId: req.institution.institutionUserId,
        brief,
      });
      return res.json({ success: true, data: { decisionId: String(decisionId) } });
    } catch (err) {
      if (/disabled/i.test(err.message)) return res.status(404).json({ success: false, message: 'Not found' });
      if (/not found/i.test(err.message)) return res.status(404).json({ success: false, message: 'Assessment not found' });
      if (/not authorable/i.test(err.message)) return res.status(409).json({ success: false, message: err.message });
      console.error('[institution/author-agent] startRun error', err);
      return res.status(500).json({ success: false, message: 'Could not start the author-agent run.' });
    }
  }

  async function getRunStatusHandler(req, res) {
    try {
      if (!d.isAgentEnabled('author_agent')) {
        return res.status(404).json({ success: false, message: 'Not found' });
      }
      const scope = institutionScope(req);
      const { status, runLog, result } = await d.getRunStatus({
        decisionId: req.params.decisionId,
        institutionId: scope.institutionId,
      });
      return res.json({ success: true, data: { status, runLog, result } });
    } catch (err) {
      if (/not found/i.test(err.message)) return res.status(404).json({ success: false, message: 'Run not found' });
      console.error('[institution/author-agent] getRunStatus error', err);
      return res.status(500).json({ success: false, message: 'Could not load the run.' });
    }
  }

  return { startRunHandler, getRunStatusHandler };
}

const router = express.Router();
const handlers = makeHandlers();
router.post(
  '/assessments/:id/author-agent',
  institutionAuth,
  requireInstitutionRole('tpo_head', 'tpo_coordinator'),
  handlers.startRunHandler
);
router.get(
  '/author-agent/runs/:decisionId',
  institutionAuth,
  requireInstitutionRole('tpo_head', 'tpo_coordinator'),
  handlers.getRunStatusHandler
);

module.exports = router;
module.exports.makeHandlers = makeHandlers;
