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

// Upper bound for the agent-create route's optional `durationMinutes`
// override — 8 hours, matching capstone's own durationSeconds ceiling (the
// longest of any authorable engine's per-attempt duration; see
// src/models/Assessment.js config.capstone.durationSeconds and
// assessmentSpecService.repairCapstone's clampInt max of 8*3600).
const MAX_DURATION_MINUTES = 480;

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
    resolveGroundingSource: deps.resolveGroundingSource || authorAgentService.resolveGroundingSource,
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
   *
   * Every error response from this route carries a stable machine-readable
   * `code` (house pattern — see src/routes/institution/assessments.js) so
   * clients key off `code`, never regex-match `message` text:
   *   400 VALIDATION     — cohortId/brief missing
   *   400 BAD_WINDOW      — opensAt/closesAt unparseable, or opensAt >= closesAt
   *   400 BAD_DURATION    — durationMinutes non-numeric or out of range
   *   404 NOT_FOUND        — author_agent flag is off
   *   404 COHORT_NOT_FOUND — cohortId doesn't exist / isn't owned by this institution
   *   404 SOURCE_NOT_FOUND — sourceId doesn't exist / isn't owned by this institution
   *   409 SOURCE_NOT_READY — sourceId exists but extraction hasn't finished yet
   *   409 SOURCE_FAILED    — sourceId exists but extraction failed
   *   422 BAD_BRIEF        — the brief couldn't be understood, even after repair
   *
   * opensAt/closesAt/durationMinutes/sourceId are all optional overrides on
   * top of the brief-derived spec — see authorAgentService.createAndAuthor's
   * doc comment for exactly how each is applied.
   */
  async function createAssessmentHandler(req, res) {
    try {
      if (!d.isAgentEnabled('author_agent')) {
        return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Not found' });
      }
      const { cohortId, brief, opensAt, closesAt, durationMinutes, sourceId } = req.body || {};
      if (!cohortId || !brief || typeof brief !== 'string') {
        return res.status(400).json({ success: false, code: 'VALIDATION', message: 'cohortId and brief are required' });
      }

      // opensAt/closesAt: parseability is this route's job — an unparseable
      // date would otherwise silently slip past createAssessment's own
      // ordering check (new Date('garbage') >= new Date('garbage2') is
      // false, not an error) and reach the DB as an Invalid Date. Ordering
      // itself (opensAt >= closesAt) is left to createAssessment's existing
      // 'BAD_WINDOW' throw, mapped below — not duplicated here.
      let parsedOpensAt;
      if (opensAt !== undefined && opensAt !== null && opensAt !== '') {
        parsedOpensAt = new Date(opensAt);
        if (Number.isNaN(parsedOpensAt.getTime())) {
          return res.status(400).json({ success: false, code: 'BAD_WINDOW', message: 'opensAt is not a valid date.' });
        }
      }
      let parsedClosesAt;
      if (closesAt !== undefined && closesAt !== null && closesAt !== '') {
        parsedClosesAt = new Date(closesAt);
        if (Number.isNaN(parsedClosesAt.getTime())) {
          return res.status(400).json({ success: false, code: 'BAD_WINDOW', message: 'closesAt is not a valid date.' });
        }
      }
      if (parsedOpensAt && parsedClosesAt && parsedOpensAt >= parsedClosesAt) {
        return res.status(400).json({ success: false, code: 'BAD_WINDOW', message: 'opensAt must be before closesAt.' });
      }

      let parsedDurationMinutes;
      if (durationMinutes !== undefined && durationMinutes !== null && durationMinutes !== '') {
        const n = Number(durationMinutes);
        if (!Number.isFinite(n) || n <= 0 || n > MAX_DURATION_MINUTES) {
          return res.status(400).json({
            success: false,
            code: 'BAD_DURATION',
            message: `durationMinutes must be a number between 1 and ${MAX_DURATION_MINUTES}.`,
          });
        }
        parsedDurationMinutes = n;
      }

      const scope = institutionScope(req);

      // sourceId: existence/ownership/readiness, checked BEFORE createAndAuthor
      // runs so a not-ready source never even reaches assessment creation —
      // see authorAgentService.resolveGroundingSource's doc comment for the
      // silently-ungrounded-questions gap this closes. createAndAuthor also
      // re-checks this itself (defence in depth, for service-side callers
      // that bypass this route entirely) — see its doc comment.
      if (sourceId) {
        try {
          await d.resolveGroundingSource({ sourceId, institutionId: scope.institutionId });
        } catch (srcErr) {
          if (srcErr.message === 'SOURCE_NOT_FOUND') {
            return res.status(404).json({ success: false, code: 'SOURCE_NOT_FOUND', message: 'Source material not found.' });
          }
          if (srcErr.message === 'SOURCE_NOT_READY') {
            return res.status(409).json({
              success: false,
              code: 'SOURCE_NOT_READY',
              message: 'That source material is still being processed — try again in a moment.',
            });
          }
          if (srcErr.message === 'SOURCE_FAILED') {
            return res.status(409).json({
              success: false,
              code: 'SOURCE_FAILED',
              message: 'That source material failed to process — please re-upload it.',
            });
          }
          throw srcErr;
        }
      }

      const { assessmentId, decisionId, spec } = await d.createAndAuthor({
        institutionId: scope.institutionId,
        cohortId,
        actorInstitutionUserId: req.institution.institutionUserId,
        brief,
        opensAt: parsedOpensAt,
        closesAt: parsedClosesAt,
        durationMinutes: parsedDurationMinutes,
        sourceId,
      });
      return res.json({
        success: true,
        data: { assessmentId: String(assessmentId), decisionId: String(decisionId), spec },
      });
    } catch (err) {
      if (/disabled/i.test(err.message)) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Not found' });
      if (/cohort not found/i.test(err.message)) {
        return res.status(404).json({ success: false, code: 'COHORT_NOT_FOUND', message: 'Cohort not found' });
      }
      if (err.message === 'BAD_WINDOW') {
        return res.status(400).json({ success: false, code: 'BAD_WINDOW', message: 'opensAt must be before closesAt.' });
      }
      if (err.message === 'SOURCE_NOT_FOUND') {
        return res.status(404).json({ success: false, code: 'SOURCE_NOT_FOUND', message: 'Source material not found.' });
      }
      if (err.message === 'SOURCE_NOT_READY') {
        return res.status(409).json({
          success: false,
          code: 'SOURCE_NOT_READY',
          message: 'That source material is still being processed — try again in a moment.',
        });
      }
      if (err.message === 'SOURCE_FAILED') {
        return res.status(409).json({
          success: false,
          code: 'SOURCE_FAILED',
          message: 'That source material failed to process — please re-upload it.',
        });
      }
      if (/could not understand/i.test(err.message)) {
        return res.status(422).json({ success: false, code: 'BAD_BRIEF', message: err.message });
      }
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
