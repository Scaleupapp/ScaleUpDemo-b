'use strict';

/**
 * Author-agent run endpoints (agentic layer, Plan 3, Task 2; made
 * engine-aware in Plan 7, Task 2).
 *
 * Kicks off authorAgentService's engine-aware generate -> QA -> (repair,
 * where applicable) run for ANY authorable assessment type — mcq, interview,
 * capstone, drill (startRun) — and exposes a polling endpoint for its run
 * status (getRunStatus), plus a list endpoint (listRuns) so a TPO who
 * refreshed mid-run — decisionId lived only in React state — can find their
 * way back to it instead of starting a duplicate run. The route itself
 * carries no engine-specific gate: authorAgentService.startRun owns the
 * full authorability guard (assessment type + status); this route just
 * scopes to the caller's institution and maps the service's errors onto
 * HTTP status codes. Flag-off returns 404 (house convention: clients treat
 * 404 as feature-off — see src/routes/v2/agentDecisions.js).
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
    createAndAuthor: deps.createAndAuthor || authorAgentService.createAndAuthor,
    listRuns: deps.listRuns || authorAgentService.listRuns,
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
      if (/already in progress/i.test(err.message)) return res.status(409).json({ success: false, message: err.message });
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

  /**
   * GET /api/institution/author-agent/runs?cohortId=&limit= — lets a TPO who
   * refreshed mid-run find their way back to it. decisionId only ever lived
   * in React state before this; this is the server-side lookup that replaces
   * "start a new run because you lost the tab". institutionScope comes from
   * the authed principal — NEVER the query — so a cohortId from another
   * institution just returns an empty list (see authorAgentService.listRuns).
   */
  async function listRunsHandler(req, res) {
    try {
      if (!d.isAgentEnabled('author_agent')) {
        return res.status(404).json({ success: false, message: 'Not found' });
      }
      const { cohortId, limit } = req.query || {};
      if (!cohortId || typeof cohortId !== 'string') {
        return res.status(400).json({ success: false, message: 'cohortId is required' });
      }

      const scope = institutionScope(req);
      const { runs } = await d.listRuns({
        institutionId: scope.institutionId,
        cohortId,
        limit: limit !== undefined ? Number(limit) : undefined,
      });
      return res.json({ success: true, data: { runs } });
    } catch (err) {
      console.error('[institution/author-agent] listRuns error', err);
      return res.status(500).json({ success: false, message: 'Could not load recent runs.' });
    }
  }

  /**
   * POST /api/institution/agent/create-assessment — the one-prompt path.
   * No pre-existing assessment shell, no picker: the TPO describes the
   * assessment they want and the agent creates it (assessmentSpecService
   * .parseBrief -> assessmentService.createAssessment) then immediately
   * kicks off the SAME author-agent run startRunHandler above starts.
   * institutionScope comes from the authed principal — NEVER the body.
   */
  async function createAssessmentHandler(req, res) {
    try {
      if (!d.isAgentEnabled('author_agent')) {
        return res.status(404).json({ success: false, message: 'Not found' });
      }
      const { cohortId, brief } = req.body || {};
      if (!cohortId || !brief || typeof brief !== 'string') {
        return res.status(400).json({ success: false, message: 'cohortId and brief are required' });
      }

      const scope = institutionScope(req);
      const { assessmentId, decisionId, spec } = await d.createAndAuthor({
        institutionId: scope.institutionId,
        cohortId,
        actorInstitutionUserId: req.institution.institutionUserId,
        brief,
      });
      return res.json({
        success: true,
        data: { assessmentId: String(assessmentId), decisionId: String(decisionId), spec },
      });
    } catch (err) {
      if (/disabled/i.test(err.message)) return res.status(404).json({ success: false, message: 'Not found' });
      if (/cohort not found/i.test(err.message)) return res.status(404).json({ success: false, message: 'Cohort not found' });
      if (/could not understand/i.test(err.message)) return res.status(422).json({ success: false, message: err.message });
      console.error('[institution/author-agent] createAndAuthor error', err);
      return res.status(500).json({ success: false, message: 'Could not create the assessment.' });
    }
  }

  return { startRunHandler, getRunStatusHandler, listRunsHandler, createAssessmentHandler };
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
  '/author-agent/runs',
  institutionAuth,
  requireInstitutionRole('tpo_head', 'tpo_coordinator'),
  handlers.listRunsHandler
);
router.get(
  '/author-agent/runs/:decisionId',
  institutionAuth,
  requireInstitutionRole('tpo_head', 'tpo_coordinator'),
  handlers.getRunStatusHandler
);
router.post(
  '/agent/create-assessment',
  institutionAuth,
  requireInstitutionRole('tpo_head', 'tpo_coordinator'),
  handlers.createAssessmentHandler
);

module.exports = router;
module.exports.makeHandlers = makeHandlers;
