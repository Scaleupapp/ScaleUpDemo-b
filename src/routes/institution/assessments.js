'use strict';
const express = require('express');
const institutionAuth = require('../../middleware/institutionAuth');
const { institutionScope, requireInstitutionRole } = require('../../middleware/institutionScope');

const router = express.Router();
router._deps = null;
function svc() { return (router._deps && router._deps.assessmentService) || require('../../services/institution/assessment/assessmentService'); }
function getAssessmentModel() { return (router._deps && router._deps.Assessment) || require('../../models/Assessment'); }
function getAssessmentSessionModel() { return (router._deps && router._deps.AssessmentSession) || require('../../models/AssessmentSession'); }
function getCohortRollupModel() { return (router._deps && router._deps.CohortRollup) || require('../../models/CohortRollup'); }

// Configure (maker): tpo_head, tpo_coordinator
router.post('/assessments', institutionAuth, requireInstitutionRole('tpo_head', 'tpo_coordinator'), async (req, res) => {
  try {
    const { cohortId, type, title } = req.body || {};
    if (!cohortId || !type || !title) return res.status(400).json({ success: false, code: 'VALIDATION', message: 'cohortId, type and title are required.' });
    const a = await svc().createAssessment(institutionScope(req), { ...req.body, createdBy: req.institution.institutionUserId });
    return res.status(201).json({ success: true, data: a });
  } catch (err) {
    if (err.name === 'ValidationError') return res.status(400).json({ success: false, code: 'VALIDATION', message: 'Invalid assessment data.' });
    console.error('[institution/assessments:create]', err.message);
    return res.status(500).json({ success: false, message: 'Could not create the assessment.' });
  }
});

// Release (checker): tpo_head, institution_admin  — different roles than configure
router.post('/assessments/:id/release', institutionAuth, requireInstitutionRole('tpo_head', 'institution_admin'), async (req, res) => {
  try {
    const a = await svc().releaseAssessment(institutionScope(req), req.params.id, req.institution.institutionUserId);
    return res.status(200).json({ success: true, data: { id: String(a._id), status: a.status, releasedAt: a.releasedAt } });
  } catch (err) {
    if (err.message === 'NOT_FOUND') return res.status(404).json({ success: false, message: 'Assessment not found' });
    if (err.message === 'BAD_STATUS') return res.status(409).json({ success: false, code: 'BAD_STATUS', message: 'Only a configured assessment can be released.' });
    console.error('[institution/assessments:release]', err.message);
    return res.status(500).json({ success: false, message: 'Could not release the assessment.' });
  }
});

// List + get (any institution role)
router.get('/assessments', institutionAuth, async (req, res) => {
  try { return res.status(200).json({ success: true, data: await svc().listAssessments(institutionScope(req), { cohortId: req.query.cohortId }) }); }
  catch (err) { console.error('[institution/assessments:list]', err.message); return res.status(500).json({ success: false, message: 'Could not list assessments.' }); }
});
router.get('/assessments/:id', institutionAuth, async (req, res) => {
  try {
    const a = await svc().getAssessment(institutionScope(req), req.params.id);
    if (!a) return res.status(404).json({ success: false, message: 'Assessment not found' });
    return res.status(200).json({ success: true, data: a });
  } catch (err) { console.error('[institution/assessments:get]', err.message); return res.status(500).json({ success: false, message: 'Could not load the assessment.' }); }
});

// ── TPO monitoring: list sessions for an assessment ────────────────────────────
// GET /assessments/:id/sessions (any institution role)
// While the window is open: returns per-student { userId, status } — score omitted
// (privacy / anti-anxiety). After closesAt, score is included.
router.get('/assessments/:id/sessions', institutionAuth, async (req, res) => {
  try {
    const scope = institutionScope(req);
    const Assessment = getAssessmentModel();
    const AssessmentSession = getAssessmentSessionModel();

    const assessment = await Assessment.findOne({ ...scope, _id: req.params.id });
    if (!assessment) return res.status(404).json({ success: false, message: 'Assessment not found' });

    const sessionsQuery = AssessmentSession.find({
      ...scope,
      assessmentId: assessment._id,
    });
    const allSessions = typeof sessionsQuery.lean === 'function'
      ? await sessionsQuery.lean()
      : await sessionsQuery;

    const now = new Date();
    const windowClosed = assessment.closesAt && now > assessment.closesAt;

    const counts = {
      assigned: allSessions.length,
      started: allSessions.filter((s) => s.status !== 'scheduled').length,
      submitted: allSessions.filter((s) => ['submitted', 'graded'].includes(s.status)).length,
      graded: allSessions.filter((s) => s.status === 'graded').length,
    };

    const sessions = allSessions.map((s) => {
      const entry = { userId: s.userId, status: s.status };
      if (windowClosed && s.result && typeof s.result.score === 'number') {
        entry.score = s.result.score;
      }
      return entry;
    });

    return res.status(200).json({ success: true, data: { counts, sessions } });
  } catch (err) {
    console.error('[institution/assessments:sessions]', err.message);
    return res.status(500).json({ success: false, message: 'Could not load sessions.' });
  }
});

// ── TPO analytics: cohort rollup ───────────────────────────────────────────────
// GET /cohorts/:cohortId/assessment-rollup?assessmentId= (any institution role)
// Returns the cached CohortRollup document (or null if not yet computed).
router.get('/cohorts/:cohortId/assessment-rollup', institutionAuth, async (req, res) => {
  try {
    const scope = institutionScope(req);
    const CohortRollup = getCohortRollupModel();
    const { assessmentId } = req.query;

    const filter = { ...scope, cohortId: req.params.cohortId };
    if (assessmentId) filter.assessmentId = assessmentId;
    else filter.assessmentId = null; // cohort-wide rollup

    const rollupQuery = CohortRollup.findOne(filter);
    const rollup = typeof rollupQuery.lean === 'function'
      ? await rollupQuery.lean()
      : await rollupQuery;
    return res.status(200).json({ success: true, data: rollup || null });
  } catch (err) {
    console.error('[institution/assessments:rollup]', err.message);
    return res.status(500).json({ success: false, message: 'Could not load rollup.' });
  }
});

module.exports = router;
