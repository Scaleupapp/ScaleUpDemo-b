'use strict';
/**
 * Student-facing assessment routes — mounted under /api/v2/me.
 * Uses D2C `auth` middleware (req.user.userId), NOT institutionAuth.
 *
 * Final paths (when mounted at /api/v2/me):
 *   GET  /api/v2/me/assessments              — list released assessments for the student's cohort(s)
 *   POST /api/v2/me/assessments/:id/start    — start a single attempt
 *   POST /api/v2/me/assessments/sessions/:sessionId/sync — sync/poll result
 *
 * DI seam: router._deps — inject { auth, assessmentSessionService,
 *   Assessment, AssessmentSession, InstitutionEnrollment, getAdapter } in tests.
 *
 * TODO(assessment-sync-worker): a BullMQ poller that calls syncSession for
 * in_progress sessions whose engine has graded is the production-grade path.
 * For now the client-driven POST .../sync is sufficient and fully tested.
 */
const express = require('express');
const realAuth = require('../../middleware/auth');
const { getAdapter: realGetAdapter } = require('../../services/institution/assessment/engineAdapters');
const reviewService = require('../../services/institution/assessment/assessmentReviewService');

const router = express.Router();
router._deps = null;

function getAuth() {
  return (router._deps && router._deps.auth) || realAuth;
}
function getSessionService() {
  return (router._deps && router._deps.assessmentSessionService)
    || require('../../services/institution/assessment/assessmentSessionService');
}
function getAssessment() {
  return (router._deps && router._deps.Assessment) || require('../../models/Assessment');
}
function getAssessmentSession() {
  return (router._deps && router._deps.AssessmentSession) || require('../../models/AssessmentSession');
}
function getEnrollment() {
  return (router._deps && router._deps.InstitutionEnrollment) || require('../../models/InstitutionEnrollment');
}
function getAdapterFn() {
  return (router._deps && router._deps.getAdapter) || realGetAdapter;
}
function getPlacementDrive() {
  return (router._deps && router._deps.PlacementDrive) || require('../../models/PlacementDrive');
}
function getNotice() { return (router._deps && router._deps.InstitutionNotice) || require('../../models/InstitutionNotice'); }
function getNoticeRead() { return (router._deps && router._deps.NoticeRead) || require('../../models/NoticeRead'); }
function getGenDownload() { return (router._deps && router._deps.generateDownloadURL) || require('../../config/s3').generateDownloadURL; }

// GET /assessments — list released assessments for the student's cohort(s)
// + left-join the student's own AssessmentSession per assessment.
router.get('/assessments', (req, res, next) => getAuth()(req, res, next), async (req, res) => {
  try {
    const userId = req.user.userId;
    const Enrollment = getEnrollment();
    const Assessment = getAssessment();
    const AssessmentSession = getAssessmentSession();

    // Resolve all cohorts this student is enrolled in.
    // We avoid chaining .lean() here so the same code works for both real Mongoose
    // queries and the plain-array stubs used in tests.
    const enrollmentsQuery = Enrollment.find({ userId });
    const enrollments = typeof enrollmentsQuery.lean === 'function'
      ? await enrollmentsQuery.lean()
      : await enrollmentsQuery;
    const cohortIds = enrollments.map((e) => e.cohortId);

    if (!cohortIds.length) {
      return res.status(200).json({ success: true, data: [] });
    }

    // Fetch released assessments for those cohorts.
    const assessmentsQuery = Assessment.find({
      cohortId: { $in: cohortIds },
      status: 'released',
    });
    const assessments = typeof assessmentsQuery.lean === 'function'
      ? await assessmentsQuery.lean()
      : await assessmentsQuery;

    if (!assessments.length) {
      return res.status(200).json({ success: true, data: [] });
    }

    // Left-join: student's session per assessment (may be null).
    const assessmentIds = assessments.map((a) => a._id);
    const sessionsQuery = AssessmentSession.find({
      assessmentId: { $in: assessmentIds },
      userId,
    });
    const sessions = typeof sessionsQuery.lean === 'function'
      ? await sessionsQuery.lean()
      : await sessionsQuery;

    const sessionByAssessmentId = {};
    for (const s of sessions) {
      sessionByAssessmentId[String(s.assessmentId)] = s;
    }

    const data = assessments.map((a) => ({
      assessment: a,
      session: sessionByAssessmentId[String(a._id)] || null,
      // Detailed per-question review unlocks for the student once the window closes.
      windowClosed: reviewService.isWindowClosed(a),
    }));

    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error('[studentAssessments:list]', err.message);
    return res.status(500).json({ success: false, message: 'Could not list assessments.' });
  }
});

// POST /assessments/:id/start — start a single graded attempt.
router.post('/assessments/:id/start', (req, res, next) => getAuth()(req, res, next), async (req, res) => {
  try {
    const userId = req.user.userId;
    const assessmentId = req.params.id;
    const svc = getSessionService();
    const session = await svc.startSession(userId, assessmentId);

    // Retrieve engine-specific start metadata (e.g. interview systemInstruction).
    // Best-effort: a meta lookup failure must never fail the start.
    let meta = {};
    try {
      const getAdapter = getAdapterFn();
      meta = await getAdapter(session.engine.type).getStartMeta(session);
    } catch (metaErr) {
      console.warn('[studentAssessments:start] getStartMeta failed:', metaErr.message);
    }

    return res.status(201).json({
      success: true,
      data: {
        assessmentSessionId: String(session._id),
        engine: session.engine,
        meta,
      },
    });
  } catch (err) {
    const msg = err.message;
    if (msg === 'NOT_RELEASED') return res.status(409).json({ success: false, code: 'NOT_RELEASED', message: 'Assessment is not released.' });
    if (msg === 'NOT_OPEN') return res.status(409).json({ success: false, code: 'NOT_OPEN', message: 'Assessment window has not opened yet.' });
    if (msg === 'CLOSED') return res.status(409).json({ success: false, code: 'CLOSED', message: 'Assessment window is closed.' });
    if (msg === 'NOT_ENROLLED') return res.status(403).json({ success: false, code: 'NOT_ENROLLED', message: 'You are not enrolled in this assessment.' });
    if (msg === 'NOT_FOUND') return res.status(404).json({ success: false, message: 'Assessment not found.' });
    console.error('[studentAssessments:start]', err.message);
    return res.status(500).json({ success: false, message: 'Could not start assessment.' });
  }
});

// POST /assessments/sessions/:sessionId/sync — poll the engine and sync result.
// Client calls this after the underlying engine reports submission.
router.post('/assessments/sessions/:sessionId/sync', (req, res, next) => getAuth()(req, res, next), async (req, res) => {
  try {
    const userId = req.user.userId;
    const { sessionId } = req.params;
    const svc = getSessionService();

    const session = await svc.syncSession(sessionId);

    // Optional ownership check — return 404 if the session doesn't belong to this user.
    if (session && String(session.userId) !== String(userId)) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }

    return res.status(200).json({
      success: true,
      data: {
        status: session.status,
        result: session.result || null,
      },
    });
  } catch (err) {
    if (err.message === 'NOT_FOUND') return res.status(404).json({ success: false, message: 'Session not found.' });
    console.error('[studentAssessments:sync]', err.message);
    return res.status(500).json({ success: false, message: 'Could not sync session.' });
  }
});

// GET /assessments/sessions/:sessionId/review — detailed per-question review.
// Gated: students only see it once the assessment window has closed (so answers
// can't be shared while peers are still taking it). Returns { windowClosed,
// score, questions } — `questions` is null/empty until unlocked.
router.get('/assessments/sessions/:sessionId/review', (req, res, next) => getAuth()(req, res, next), async (req, res) => {
  try {
    const userId = req.user.userId;
    const { sessionId } = req.params;
    const AssessmentSession = getAssessmentSession();
    const Assessment = getAssessment();

    const sessionQuery = AssessmentSession.findById(sessionId);
    const session = typeof sessionQuery.lean === 'function' ? await sessionQuery.lean() : await sessionQuery;
    if (!session || String(session.userId) !== String(userId)) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }

    const assessmentQuery = Assessment.findById(session.assessmentId);
    const assessment = typeof assessmentQuery.lean === 'function' ? await assessmentQuery.lean() : await assessmentQuery;
    const windowClosed = reviewService.isWindowClosed(assessment);

    if (!windowClosed) {
      // Locked — score is already visible elsewhere; withhold the answers.
      return res.status(200).json({ success: true, data: { windowClosed: false, questions: [] } });
    }

    const review = await reviewService.buildMcqReview(session);
    return res.status(200).json({
      success: true,
      data: {
        windowClosed: true,
        score: session.result ? session.result.score : null,
        engineType: review ? review.engineType : (session.engine ? session.engine.type : null),
        questions: review ? review.questions : [],
      },
    });
  } catch (err) {
    console.error('[studentAssessments:review]', err.message);
    return res.status(500).json({ success: false, message: 'Could not load review.' });
  }
});

// GET /placement/companies — recruiting drives for the student's cohort(s).
router.get('/placement/companies', (req, res, next) => getAuth()(req, res, next), async (req, res) => {
  try {
    const userId = req.user.userId;
    const Enrollment = getEnrollment();
    const PlacementDrive = getPlacementDrive();
    const enrollmentsQuery = Enrollment.find({ userId });
    const enrollments = typeof enrollmentsQuery.lean === 'function' ? await enrollmentsQuery.lean() : await enrollmentsQuery;
    const cohortIds = enrollments.map((e) => e.cohortId);
    if (!cohortIds.length) return res.status(200).json({ success: true, data: [] });
    // Defense-in-depth: also filter by the student's institutionId(s) to prevent
    // cross-institution data leakage if cohortId happens to match another institution.
    const institutionIds = [...new Set(enrollments.map((e) => e.institutionId).filter(Boolean))];
    const driveFilter = { cohortId: { $in: cohortIds } };
    if (institutionIds.length) driveFilter.institutionId = { $in: institutionIds };
    const drivesQuery = PlacementDrive.find(driveFilter);
    const drives = typeof drivesQuery.lean === 'function' ? await drivesQuery.lean() : await drivesQuery;
    // Null-date-last sort: drives with a driveDate come first (ascending),
    // then drives without a driveDate (sorted by createdAt).
    drives.sort((a, b) => {
      const aHas = !!a.driveDate;
      const bHas = !!b.driveDate;
      if (aHas && bHas) return new Date(a.driveDate) - new Date(b.driveDate);
      if (aHas) return -1;
      if (bHas) return 1;
      // Both have no driveDate: sort by createdAt
      return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
    });
    return res.status(200).json({ success: true, data: drives });
  } catch (err) {
    console.error('[studentAssessments:companies]', err.message);
    return res.status(500).json({ success: false, message: 'Could not list companies.' });
  }
});

// GET /placement/notices — cohort notices with this student's read state.
router.get('/placement/notices', (req, res, next) => getAuth()(req, res, next), async (req, res) => {
  try {
    const userId = req.user.userId;
    const Enrollment = getEnrollment();
    const enq = Enrollment.find({ userId });
    const enrollments = typeof enq.lean === 'function' ? await enq.lean() : await enq;
    const cohortIds = enrollments.map((e) => e.cohortId);
    if (!cohortIds.length) return res.status(200).json({ success: true, data: [] });
    const Notice = getNotice();
    const nq = Notice.find({ cohortId: { $in: cohortIds } }).sort({ pinned: -1, createdAt: -1 });
    const notices = typeof nq.lean === 'function' ? await nq.lean() : await nq;
    const NoticeRead = getNoticeRead();
    const rq = NoticeRead.find({ userId, noticeId: { $in: notices.map((n) => n._id) } });
    const reads = typeof rq.lean === 'function' ? await rq.lean() : await rq;
    const readSet = new Set(reads.map((r) => String(r.noticeId)));
    const genDownload = getGenDownload();
    const data = [];
    for (const n of notices) {
      let attachment = null;
      if (n.attachment && n.attachment.s3Key) {
        let url = null;
        try { url = await genDownload(n.attachment.s3Key); } catch (e) { url = null; }
        attachment = { fileName: n.attachment.fileName, mime: n.attachment.mime, url };
      }
      data.push({ _id: n._id, title: n.title, body: n.body, pinned: !!n.pinned, link: n.link || null, attachment, createdAt: n.createdAt, read: readSet.has(String(n._id)) });
    }
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error('[studentAssessments:notices]', err.message);
    return res.status(500).json({ success: false, message: 'Could not list notices.' });
  }
});

// POST /placement/notices/:noticeId/read — mark a notice read (idempotent upsert).
router.post('/placement/notices/:noticeId/read', (req, res, next) => getAuth()(req, res, next), async (req, res) => {
  try {
    const userId = req.user.userId;
    const NoticeRead = getNoticeRead();
    await NoticeRead.updateOne({ noticeId: req.params.noticeId, userId }, { $setOnInsert: { readAt: new Date() } }, { upsert: true });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[studentAssessments:notice-read]', err.message);
    return res.status(500).json({ success: false, message: 'Could not mark read.' });
  }
});

module.exports = router;
