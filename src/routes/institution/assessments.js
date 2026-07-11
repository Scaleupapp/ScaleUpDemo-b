'use strict';
const express = require('express');
const institutionAuth = require('../../middleware/institutionAuth');
const { institutionScope, requireInstitutionRole } = require('../../middleware/institutionScope');
const reviewService = require('../../services/institution/assessment/assessmentReviewService');
const { getConfiguredDurationSeconds } = require('../../services/institution/assessment/assessmentSessionService');
const integrityService = require('../../services/institution/assessment/assessmentIntegrityService');

// Warn the TPO when an assessment can strand its cohort: no scheduled close AND
// no per-attempt duration ⇒ attempts never auto-end and detailed review never
// unlocks until a manual close (Wave 3 block 3).
function buildCreateWarnings(a) {
  const warnings = [];
  if (!a.closesAt && !getConfiguredDurationSeconds(a)) {
    warnings.push({
      code: 'NO_CLOSE_NO_DURATION',
      message: 'This assessment has no close time and no duration: student attempts never auto-end and detailed review stays locked until you manually close it.',
    });
  }
  return warnings;
}

const router = express.Router();
router._deps = null;
function svc() { return (router._deps && router._deps.assessmentService) || require('../../services/institution/assessment/assessmentService'); }
function authoring() { return (router._deps && router._deps.authoringService) || require('../../services/institution/assessment/assessmentAuthoringService'); }
function getAssessmentModel() { return (router._deps && router._deps.Assessment) || require('../../models/Assessment'); }
function getAssessmentSessionModel() { return (router._deps && router._deps.AssessmentSession) || require('../../models/AssessmentSession'); }
function getCohortRollupModel() { return (router._deps && router._deps.CohortRollup) || require('../../models/CohortRollup'); }
// Sub-feature A: injectable enrollment model
function getEnrollmentModel() { return (router._deps && router._deps.InstitutionEnrollment) || require('../../models/InstitutionEnrollment'); }
// TPO Granular Analytics: injectable User model and report service
function getUserModel() { return (router._deps && router._deps.User) || require('../../models/User'); }
function getReportService() { return (router._deps && router._deps.reportService) || require('../../services/institution/assessment/assessmentReportService'); }
// Feature 4/5: injectable cohort/template/bundle models and suggestion service
function getCohortModel() { return (router._deps && router._deps.InstitutionCohort) || require('../../models/InstitutionCohort'); }
// Task 2: injectable trends service
function getTrendsService() { return (router._deps && router._deps.trendsService) || require('../../services/institution/assessment/assessmentTrendsService'); }
function getObjectiveTemplateModel() { return (router._deps && router._deps.ObjectiveTemplate) || require('../../models/ObjectiveTemplate'); }
function getArtifactBundleModel() { return (router._deps && router._deps.ArtifactBundle) || require('../../coding/models/artifactBundle.model'); }
function getSuggestionService() { return (router._deps && router._deps.suggestionService) || require('../../services/institution/assessment/assessmentSuggestionService'); }

// Configure (maker): tpo_head, tpo_coordinator
router.post('/assessments', institutionAuth, requireInstitutionRole('tpo_head', 'tpo_coordinator'), async (req, res) => {
  try {
    const { cohortId, type, title } = req.body || {};
    if (!cohortId || !type || !title) return res.status(400).json({ success: false, code: 'VALIDATION', message: 'cohortId, type and title are required.' });
    const a = await svc().createAssessment(institutionScope(req), { ...req.body, createdBy: req.institution.institutionUserId });
    // Fire-and-forget: author MCQ questions in background (no-op for non-mcq types)
    if (a.type === 'mcq') {
      authoring().authorMcq(a._id).catch((e) => console.warn('[assessments:authorMcq]', e.message));
    }
    if (a.type === 'capstone') {
      authoring().authorCapstone(a._id).catch((e) => console.warn('[assessments:authorCapstone]', e.message));
    }
    if (a.type === 'drill') {
      authoring().authorDrill(a._id).catch((e) => console.warn('[assessments:authorDrill]', e.message));
    }
    // Interview question-plan authoring (Wave 2 block 4). typeof-guard keeps
    // injected stubs that don't provide authorInterview working.
    if (a.type === 'interview' && typeof authoring().authorInterview === 'function') {
      authoring().authorInterview(a._id).catch((e) => console.warn('[assessments:authorInterview]', e.message));
    }
    // Review-unlock contract + stranding warnings (Wave 3 block 3). Additive
    // top-level fields — existing clients that read only `data` are unaffected.
    return res.status(201).json({
      success: true,
      data: a,
      reviewUnlockPolicy: reviewService.reviewUnlockPolicy(a),
      warnings: buildCreateWarnings(a),
    });
  } catch (err) {
    // Sub-feature E: validation error codes
    if (err.message === 'COHORT_NOT_FOUND') return res.status(404).json({ success: false, code: 'COHORT_NOT_FOUND', message: 'Cohort not found or does not belong to this institution.' });
    if (err.message === 'BAD_CONFIG') return res.status(400).json({ success: false, code: 'BAD_CONFIG', message: 'Missing required engine configuration.' });
    if (err.message === 'BAD_WINDOW') return res.status(400).json({ success: false, code: 'BAD_WINDOW', message: 'opensAt must be before closesAt.' });
    if (err.name === 'ValidationError') return res.status(400).json({ success: false, code: 'VALIDATION', message: 'Invalid assessment data.' });
    console.error('[institution/assessments:create]', err.message);
    return res.status(500).json({ success: false, message: 'Could not create the assessment.' });
  }
});

// Release (checker): tpo_head, institution_admin  — different roles than configure
router.post('/assessments/:id/release', institutionAuth, requireInstitutionRole('tpo_head', 'institution_admin'), async (req, res) => {
  try {
    const a = await svc().releaseAssessment(institutionScope(req), req.params.id, req.institution.institutionUserId);
    return res.status(200).json({ success: true, data: { id: String(a._id), status: a.status, releasedAt: a.releasedAt, reviewUnlockPolicy: reviewService.reviewUnlockPolicy(a) } });
  } catch (err) {
    if (err.message === 'NOT_FOUND') return res.status(404).json({ success: false, message: 'Assessment not found' });
    if (err.message === 'BAD_STATUS') return res.status(409).json({ success: false, code: 'BAD_STATUS', message: 'Only a configured assessment can be released.' });
    if (err.message === 'NO_QUESTIONS') return res.status(409).json({ success: false, code: 'NO_QUESTIONS', message: 'Questions are still being generated — try again in a moment.' });
    if (err.message === 'AUTHORING_FAILED') return res.status(409).json({ success: false, code: 'AUTHORING_FAILED', message: 'Question generation failed quality checks — regenerate the assessment before releasing.' });
    if (err.message === 'NO_BUNDLE') return res.status(409).json({ success: false, code: 'NO_BUNDLE', message: 'The capstone is still being generated — try again in a moment.' });
    console.error('[institution/assessments:release]', err.message);
    return res.status(500).json({ success: false, message: 'Could not release the assessment.' });
  }
});

// Sub-feature C: Close action (I5): tpo_head, institution_admin
router.post('/assessments/:id/close', institutionAuth, requireInstitutionRole('tpo_head', 'institution_admin'), async (req, res) => {
  try {
    const a = await svc().closeAssessment(institutionScope(req), req.params.id, req.institution.institutionUserId);
    return res.status(200).json({ success: true, data: { id: String(a._id), status: a.status, closedAt: a.closedAt } });
  } catch (err) {
    if (err.message === 'NOT_FOUND') return res.status(404).json({ success: false, message: 'Assessment not found' });
    console.error('[institution/assessments:close]', err.message);
    return res.status(500).json({ success: false, message: 'Could not close the assessment.' });
  }
});

// Sub-feature D: Re-author MCQ (recovery): tpo_head, tpo_coordinator
// Blocked once released — the frozen master must not be re-authored under students.
router.post('/assessments/:id/author-mcq', institutionAuth, requireInstitutionRole('tpo_head', 'tpo_coordinator'), async (req, res) => {
  try {
    const Assessment = getAssessmentModel();
    const a = await Assessment.findOne({ ...institutionScope(req), _id: req.params.id });
    if (!a) return res.status(404).json({ success: false, message: 'Assessment not found' });
    if (a.status === 'released' || a.status === 'closed') {
      return res.status(409).json({ success: false, code: 'ALREADY_RELEASED', message: 'A released assessment cannot be re-authored.' });
    }
    authoring().authorMcq(a._id).catch((e) => console.warn('[assessments:author-mcq]', e.message));
    return res.status(202).json({ success: true, data: { status: 'authoring' } });
  } catch (err) {
    console.error('[institution/assessments:author-mcq]', err.message);
    return res.status(500).json({ success: false, message: 'Could not trigger authoring.' });
  }
});

// Single-item MCQ regeneration (recovery): tpo_head, tpo_coordinator
// Regenerates ONE authored question through the same 3 QA gates. Blocked once released.
router.post('/assessments/:id/questions/:qIndex/regenerate', institutionAuth, requireInstitutionRole('tpo_head', 'tpo_coordinator'), async (req, res) => {
  try {
    const Assessment = getAssessmentModel();
    const a = await Assessment.findOne({ ...institutionScope(req), _id: req.params.id });
    if (!a) return res.status(404).json({ success: false, message: 'Assessment not found' });
    const updated = await authoring().regenerateQuestion(a._id, req.params.qIndex);
    return res.status(200).json({ success: true, data: { qIndex: Number(req.params.qIndex), status: 'regenerated', questionCount: (updated.config.mcq.questions || []).length } });
  } catch (err) {
    if (err.message === 'NOT_FOUND') return res.status(404).json({ success: false, message: 'Assessment not found' });
    if (err.message === 'NOT_MCQ') return res.status(400).json({ success: false, code: 'NOT_MCQ', message: 'Only MCQ assessments have per-question regeneration.' });
    if (err.message === 'RELEASED') return res.status(409).json({ success: false, code: 'ALREADY_RELEASED', message: 'A released assessment cannot be edited.' });
    if (err.message === 'BAD_INDEX') return res.status(400).json({ success: false, code: 'BAD_INDEX', message: 'Question index out of range.' });
    if (err.message === 'REGEN_FAILED') return res.status(409).json({ success: false, code: 'REGEN_FAILED', message: 'Could not generate a passing replacement — try again.' });
    console.error('[institution/assessments:regenerate-question]', err.message);
    return res.status(500).json({ success: false, message: 'Could not regenerate the question.' });
  }
});

// Sub-feature D: Re-author Capstone (recovery): tpo_head, tpo_coordinator
router.post('/assessments/:id/author-capstone', institutionAuth, requireInstitutionRole('tpo_head', 'tpo_coordinator'), async (req, res) => {
  try {
    const Assessment = getAssessmentModel();
    const a = await Assessment.findOne({ ...institutionScope(req), _id: req.params.id });
    if (!a) return res.status(404).json({ success: false, message: 'Assessment not found' });
    authoring().authorCapstone(a._id).catch((e) => console.warn('[assessments:author-capstone]', e.message));
    return res.status(202).json({ success: true, data: { status: 'authoring' } });
  } catch (err) {
    console.error('[institution/assessments:author-capstone]', err.message);
    return res.status(500).json({ success: false, message: 'Could not trigger authoring.' });
  }
});

// Re-author Interview question plan (recovery): tpo_head, tpo_coordinator
// Blocked once released — the plan (grading anchors) must not change under students.
router.post('/assessments/:id/author-interview', institutionAuth, requireInstitutionRole('tpo_head', 'tpo_coordinator'), async (req, res) => {
  try {
    const Assessment = getAssessmentModel();
    const a = await Assessment.findOne({ ...institutionScope(req), _id: req.params.id });
    if (!a) return res.status(404).json({ success: false, message: 'Assessment not found' });
    if (a.status === 'released' || a.status === 'closed') {
      return res.status(409).json({ success: false, code: 'ALREADY_RELEASED', message: 'A released assessment cannot be re-authored.' });
    }
    authoring().authorInterview(a._id).catch((e) => console.warn('[assessments:author-interview]', e.message));
    return res.status(202).json({ success: true, data: { status: 'authoring' } });
  } catch (err) {
    console.error('[institution/assessments:author-interview]', err.message);
    return res.status(500).json({ success: false, message: 'Could not trigger authoring.' });
  }
});

// Re-author Drill (recovery): tpo_head, tpo_coordinator
router.post('/assessments/:id/author-drill', institutionAuth, requireInstitutionRole('tpo_head', 'tpo_coordinator'), async (req, res) => {
  try {
    const Assessment = getAssessmentModel();
    const a = await Assessment.findOne({ ...institutionScope(req), _id: req.params.id });
    if (!a) return res.status(404).json({ success: false, message: 'Assessment not found' });
    authoring().authorDrill(a._id).catch((e) => console.warn('[assessments:author-drill]', e.message));
    return res.status(202).json({ success: true, data: { status: 'authoring' } });
  } catch (err) {
    console.error('[institution/assessments:author-drill]', err.message);
    return res.status(500).json({ success: false, message: 'Could not trigger authoring.' });
  }
});

// List + get (any institution role)
router.get('/assessments', institutionAuth, async (req, res) => {
  try {
    const list = await svc().listAssessments(institutionScope(req), { cohortId: req.query.cohortId });
    // Expose reviewUnlockPolicy per row (additive) so the portal can label when
    // students will see their detailed review.
    const data = (list || []).map((a) => {
      const o = a && typeof a.toObject === 'function' ? a.toObject() : a;
      return { ...o, reviewUnlockPolicy: reviewService.reviewUnlockPolicy(o) };
    });
    return res.status(200).json({ success: true, data });
  } catch (err) { console.error('[institution/assessments:list]', err.message); return res.status(500).json({ success: false, message: 'Could not list assessments.' }); }
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
// (privacy / anti-anxiety). After closesAt or status=closed, score is included.
router.get('/assessments/:id/sessions', institutionAuth, async (req, res) => {
  try {
    const scope = institutionScope(req);
    const Assessment = getAssessmentModel();
    const AssessmentSession = getAssessmentSessionModel();
    const InstitutionEnrollment = getEnrollmentModel();

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
    // Sub-feature C: windowClosed also triggered by assessment.status === 'closed'
    const windowClosed = assessment.status === 'closed' || (assessment.closesAt && now > assessment.closesAt);

    // Sub-feature A: assigned = enrollment count (not session count)
    const assigned = await InstitutionEnrollment.countDocuments({ cohortId: assessment.cohortId, status: { $ne: 'withdrawn' } });

    // Honest lifecycle buckets (Wave 3 block 2): expired is a distinct bucket.
    const counts = {
      assigned,
      started: allSessions.filter((s) => s.status !== 'scheduled').length,
      submitted: allSessions.filter((s) => ['submitted', 'graded'].includes(s.status)).length,
      graded: allSessions.filter((s) => s.status === 'graded').length,
      expired: allSessions.filter((s) => s.status === 'expired').length,
    };

    // Batch-fetch enrollment + user info for name/rollNumber — no N+1
    const userIds = allSessions.map((s) => s.userId);
    const User = getUserModel();
    const [enrollmentDocs, userDocs] = await Promise.all([
      (function () {
        const q = InstitutionEnrollment.find({ cohortId: assessment.cohortId, userId: { $in: userIds } });
        return typeof q.lean === 'function' ? q.lean() : q;
      }()),
      (function () {
        const q = User.find({ _id: { $in: userIds } }, { firstName: 1, lastName: 1 });
        return typeof q.lean === 'function' ? q.lean() : q;
      }()),
    ]);

    const enrollmentByUserId = {};
    for (const e of enrollmentDocs) { enrollmentByUserId[String(e.userId)] = e; }
    const userById = {};
    for (const u of userDocs) { userById[String(u._id)] = u; }

    const sessions = allSessions.map((s) => {
      const uid = String(s.userId);
      const enrollment = enrollmentByUserId[uid];
      const user = userById[uid];
      let name = '';
      if (user) {
        name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
      }
      const rollNumber = (enrollment && enrollment.rollNumber) ? enrollment.rollNumber : '';
      const entry = { userId: s.userId, name, rollNumber, status: s.status };
      // Honest per-student surfacing (Wave 3 block 2): needsReview (grade disputed
      // by the answer-side judge) + insufficient (too little evidence to grade).
      if (s.result && s.result.needsReview) entry.needsReview = true;
      if (s.result && s.result.gradeStatus) entry.gradeStatus = s.result.gradeStatus;
      // TPO sees scores immediately — this endpoint is institution-authenticated
      // (placement office only). The anti-anxiety/anti-cheat hold-back applies to the
      // STUDENT-facing reveal, not the TPO dashboard.
      if (s.result && typeof s.result.score === 'number') {
        entry.score = s.result.score;
      }
      return entry;
    });

    // Integrity truth + per-engine score framing (Wave 3 block 4).
    const integrity = integrityService.summarizeIntegrity(allSessions.filter((s) => s.status !== 'scheduled'));
    return res.status(200).json({
      success: true,
      data: {
        counts, sessions,
        reviewUnlockPolicy: reviewService.reviewUnlockPolicy(assessment),
        scoreMethod: integrityService.scoreMethodForEngine(assessment.type),
        integrity,
      },
    });
  } catch (err) {
    console.error('[institution/assessments:sessions]', err.message);
    return res.status(500).json({ success: false, message: 'Could not load sessions.' });
  }
});

// ── TPO Granular Analytics: per-student detail ────────────────────────────────
// GET /assessments/:id/sessions/:userId (any institution role)
router.get('/assessments/:id/sessions/:userId', institutionAuth, async (req, res) => {
  try {
    const scope = institutionScope(req);
    const Assessment = getAssessmentModel();
    const AssessmentSession = getAssessmentSessionModel();
    const InstitutionEnrollment = getEnrollmentModel();
    const User = getUserModel();

    const assessment = await Assessment.findOne({ ...scope, _id: req.params.id });
    if (!assessment) return res.status(404).json({ success: false, message: 'Assessment not found' });

    const session = await AssessmentSession.findOne({ ...scope, assessmentId: assessment._id, userId: req.params.userId });
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

    const now = new Date();
    const windowClosed = assessment.status === 'closed' || (assessment.closesAt && now > assessment.closesAt);

    const [enrollment, user] = await Promise.all([
      InstitutionEnrollment.findOne({ cohortId: assessment.cohortId, userId: req.params.userId }),
      User.findOne({ _id: req.params.userId }, { firstName: 1, lastName: 1 }),
    ]);

    let name = '';
    if (user) {
      name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
    }
    const rollNumber = (enrollment && enrollment.rollNumber) ? enrollment.rollNumber : '';

    const result = session.result || {};
    const data = {
      name,
      rollNumber,
      userId: String(session.userId),
      status: session.status,
      startedAt: session.startedAt || null,
      submittedAt: session.submittedAt || null,
      gradedAt: session.gradedAt || null,
      deadlineAt: session.deadlineAt || null,
      // Honest grade surfacing (Wave 3 block 2).
      needsReview: !!result.needsReview,
      gradeStatus: result.gradeStatus || null,
      integrity: result.integrity != null ? result.integrity : null,
      raw: result.raw != null ? result.raw : null,
    };

    // TPO sees the score immediately (institution-only endpoint).
    if (typeof result.score === 'number') {
      data.score = result.score;
    }

    // TPO also sees the detailed per-question review (ungated) for MCQ sessions.
    try {
      const reviewService = require('../../services/institution/assessment/assessmentReviewService');
      const review = await reviewService.buildMcqReview(session);
      if (review) data.questions = review.questions;
    } catch (revErr) {
      console.warn('[institution/assessments:session-detail] review build failed:', revErr.message);
    }

    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error('[institution/assessments:session-detail]', err.message);
    return res.status(500).json({ success: false, message: 'Could not load session detail.' });
  }
});

// ── TPO Granular Analytics: CSV export ────────────────────────────────────────
// GET /assessments/:id/export.csv (any institution role)
router.get('/assessments/:id/export.csv', institutionAuth, async (req, res) => {
  try {
    const scope = institutionScope(req);
    const Assessment = getAssessmentModel();
    const CohortRollup = getCohortRollupModel();
    const reportService = getReportService();

    const assessment = await Assessment.findOne({ ...scope, _id: req.params.id });
    if (!assessment) return res.status(404).json({ success: false, message: 'Assessment not found' });

    const now = new Date();
    const windowClosed = assessment.status === 'closed' || (assessment.closesAt && now > assessment.closesAt);

    // Fetch rollup for competency column names
    const rollupQuery = CohortRollup.findOne({ ...scope, cohortId: assessment.cohortId, assessmentId: assessment._id });
    const rollup = typeof rollupQuery.then === 'function'
      ? await rollupQuery
      : (typeof rollupQuery.lean === 'function' ? await rollupQuery.lean() : await rollupQuery);

    const competencyColumns = (rollup && rollup.byCompetency || []).map((c) => c.name);

    const rows = await reportService.buildSessionRows(
      assessment._id,
      { revealScores: true, cohortId: assessment.cohortId }, // TPO export always includes scores
      {
        AssessmentSession: getAssessmentSessionModel(),
        InstitutionEnrollment: getEnrollmentModel(),
        User: getUserModel(),
      }
    );

    const csv = reportService.toCsv(rows, competencyColumns);

    const safeTitle = (assessment.title || 'export').replace(/"/g, "'");
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.csv"`);
    return res.send(csv);
  } catch (err) {
    console.error('[institution/assessments:export-csv]', err.message);
    return res.status(500).json({ success: false, message: 'Could not export CSV.' });
  }
});

// ── Task 2: Cross-cohort comparison (MUST be before /:cohortId routes) ────────
// GET /cohorts/comparison?cohortIds=c1,c2,...  (any institution role)
router.get('/cohorts/comparison', institutionAuth, async (req, res) => {
  try {
    const scope = institutionScope(req);
    const rawIds = req.query.cohortIds || '';
    const cohortIds = rawIds.split(',').map(s => s.trim()).filter(Boolean);
    if (cohortIds.length === 0) return res.status(400).json({ success: false, message: 'cohortIds query param required' });

    const trends = getTrendsService();
    const data = await trends.buildComparison(scope.institutionId, cohortIds, {
      InstitutionCohort: getCohortModel(),
      CohortRollup: getCohortRollupModel(),
    });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error('[institution/assessments:comparison]', err.message);
    return res.status(500).json({ success: false, message: 'Could not load comparison.' });
  }
});

// ── Task 2: Trends time-series for a single cohort ────────────────────────────
// GET /cohorts/:cohortId/trends  (any institution role, scoped)
router.get('/cohorts/:cohortId/trends', institutionAuth, async (req, res) => {
  try {
    const scope = institutionScope(req);
    const InstitutionCohort = getCohortModel();
    // Scope-check: 404 if cohort not in institution
    const cohortQuery = InstitutionCohort.findOne({ ...scope, _id: req.params.cohortId });
    const cohort = typeof cohortQuery.lean === 'function' ? await cohortQuery.lean() : await cohortQuery;
    if (!cohort) return res.status(404).json({ success: false, message: 'Cohort not found' });

    const trends = getTrendsService();
    const data = await trends.buildTrends(req.params.cohortId, {
      CohortRollup: getCohortRollupModel(),
      Assessment: getAssessmentModel(),
    });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error('[institution/assessments:trends]', err.message);
    return res.status(500).json({ success: false, message: 'Could not load trends.' });
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

// ── Feature 4: Assessment suggestions based on cohort objective ──────────────
// GET /cohorts/:cohortId/assessment-suggestions (any institution role, scoped)
router.get('/cohorts/:cohortId/assessment-suggestions', institutionAuth, async (req, res) => {
  try {
    const scope = institutionScope(req);
    const InstitutionCohort = getCohortModel();
    const ObjectiveTemplate = getObjectiveTemplateModel();

    // Load cohort (scoped — must belong to this institution)
    const cohortQuery = InstitutionCohort.findOne({ ...scope, _id: req.params.cohortId });
    const cohort = typeof cohortQuery.lean === 'function' ? await cohortQuery.lean() : await cohortQuery;
    if (!cohort) return res.status(404).json({ success: false, message: 'Cohort not found' });

    // Load template if linked
    let template = null;
    if (cohort.objectiveTemplateId) {
      const tplQuery = ObjectiveTemplate.findOne({ _id: cohort.objectiveTemplateId });
      template = typeof tplQuery.lean === 'function' ? await tplQuery.lean() : await tplQuery;
    }

    const svc = getSuggestionService();
    const result = svc.buildSuggestions(cohort, template);

    // Best-effort LLM enrichment: re-order and sharpen reasons.
    // Falls back to rule-based order on any failure (never throws to the client).
    if (result.suggestions && result.suggestions.length > 0 && svc.rankSuggestions) {
      try {
        const rankDeps = (router._deps && router._deps.rankDeps) || {};
        result.suggestions = await svc.rankSuggestions(
          result.suggestions, cohort, template, rankDeps
        );
      } catch (_rankErr) {
        // rankSuggestions has its own internal try/catch, so this is a safety net
      }
    }

    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    console.error('[institution/assessments:suggestions]', err.message);
    return res.status(500).json({ success: false, message: 'Could not build assessment suggestions.' });
  }
});

// ── Feature 5: Content preview before release ─────────────────────────────────
// GET /assessments/:id/preview (any institution role, scoped)
// TPO staff may see full MCQ content (incl. correctAnswer) — they are reviewing before release.
// Capstone/drill: returns safeBundleView — NEVER reference_solution/hidden_tests.
router.get('/assessments/:id/preview', institutionAuth, async (req, res) => {
  try {
    const scope = institutionScope(req);
    const Assessment = getAssessmentModel();
    const ArtifactBundle = getArtifactBundleModel();

    const a = await Assessment.findOne({ ...scope, _id: req.params.id });
    if (!a) return res.status(404).json({ success: false, message: 'Assessment not found' });

    const type = a.type;
    let preview = { type };

    if (type === 'mcq') {
      const mcqCfg = (a.config && a.config.mcq) || {};
      const questions = mcqCfg.questions || [];
      const authoring = mcqCfg.authoring || null;
      const ready = !!(questions && questions.length);
      preview = {
        type: 'mcq',
        ready,
        // Honest authoring status + aggregate QA evidence for the TPO.
        authoringStatus: authoring ? authoring.status : (ready ? 'ready' : undefined),
        qaReport: authoring ? authoring.qaReport : undefined,
        perStudentCount: mcqCfg.questionCount || undefined,
        questionCount: questions.length,
        questions: questions.map((q) => {
          const opts = q.options || [];
          // correctAnswer may be a numeric index, a label (A/B/..), or the option
          // text/_id — normalize to an index so the UI can highlight the right one.
          let correct = -1;
          if (typeof q.correctAnswer === 'number') {
            correct = q.correctAnswer;
          } else if (q.correctAnswer != null) {
            const target = String(q.correctAnswer);
            correct = opts.findIndex((o, i) => {
              if (typeof o === 'string') return o === target || String.fromCharCode(65 + i) === target;
              return target === o.label || target === o.text || String(o._id) === target;
            });
          }
          return {
            // The web reads `question` + `correct`; the backend stored `questionText`
            // + `correctAnswer`. Return BOTH names so the preview always renders.
            question: q.questionText || q.question || '',
            questionText: q.questionText || q.question || '',
            options: opts,
            correct,
            correctAnswer: q.correctAnswer,
            concept: q.concept,
            competency: q.competency,
            // Per-item quality evidence (lint/solver/judge verdicts) for the TPO.
            qa: q.qa
              ? {
                  lintPassed: !!(q.qa.lint && q.qa.lint.passed),
                  solverAgrees: !!(q.qa.solver && q.qa.solver.agrees),
                  solverConfidence: q.qa.solver ? q.qa.solver.confidence : undefined,
                  judgeVerdict: q.qa.judge ? q.qa.judge.verdict : undefined,
                  judgeScores: q.qa.judge ? q.qa.judge.scores : undefined,
                  generation: q.qa.generation,
                }
              : undefined,
          };
        }),
      };
    } else if (type === 'capstone' || type === 'drill') {
      const configKey = type; // 'capstone' or 'drill'
      const bundleId = a.config && a.config[configKey] && a.config[configKey].bundleId;
      if (!bundleId) {
        preview = { type, ready: false, message: 'Bundle not yet generated.' };
      } else {
        const bundleQuery = ArtifactBundle.findOne({ _id: bundleId });
        const bundle = typeof bundleQuery.lean === 'function' ? await bundleQuery.lean() : await bundleQuery;
        if (!bundle) {
          preview = { type, ready: false, message: 'Bundle not found.' };
        } else {
          // Safe view: NEVER includes reference_solution or hidden_tests
          preview = {
            type,
            ready: true,
            brief: bundle.brief,
            acceptance_criteria: bundle.acceptance_criteria,
            visible_tests: bundle.visible_tests,
            difficulty: bundle.difficulty,
            time_budget_minutes: bundle.time_budget_minutes,
            role_track: bundle.role_track,
            language: bundle.language,
          };
        }
      }
    } else if (type === 'interview') {
      // No pre-generated content; per-session dynamic
      preview = {
        type: 'interview',
        ready: true,
        config: (a.config && a.config.interview) || {},
      };
    }

    return res.status(200).json({ success: true, data: preview });
  } catch (err) {
    console.error('[institution/assessments:preview]', err.message);
    return res.status(500).json({ success: false, message: 'Could not load preview.' });
  }
});

module.exports = router;
