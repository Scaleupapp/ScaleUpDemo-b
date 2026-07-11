'use strict';
const express = require('express');
const institutionAuth = require('../../middleware/institutionAuth');
const { institutionScope } = require('../../middleware/institutionScope');
const { scoreMethodForEngine } = require('../../services/institution/assessment/assessmentIntegrityService');

const router = express.Router();
router._deps = null;

// Per-engine at-risk score thresholds (Wave 3 block 4). Keyed by scoreMethod so
// objective (mcq) and ai_judged (interview/capstone/drill) are compared within
// their own bucket — never cross-averaged. Env-overridable.
const AT_RISK_THRESHOLDS = {
  objective: Number(process.env.AT_RISK_THRESHOLD_OBJECTIVE) || 40,
  ai_judged: Number(process.env.AT_RISK_THRESHOLD_AI_JUDGED) || 40,
};

// Dependency injection helpers
function getCohortRollupModel() { return (router._deps && router._deps.CohortRollup) || require('../../models/CohortRollup'); }
function getAssessmentSessionModel() { return (router._deps && router._deps.AssessmentSession) || require('../../models/AssessmentSession'); }
function getAssessmentModel() { return (router._deps && router._deps.Assessment) || require('../../models/Assessment'); }
function getEnrollmentModel() { return (router._deps && router._deps.InstitutionEnrollment) || require('../../models/InstitutionEnrollment'); }
function getUserModel() { return (router._deps && router._deps.User) || require('../../models/User'); }

// ── GET /cohorts/:cohortId/analytics  (any institution role, institution-scoped) ─
// Returns:
//   competencies: [{name, avgScore, n}] — from latest cohort-wide CohortRollup, sorted
//                 weakest-first (ascending avgScore).
//   atRisk: [{studentName, rollNumber?, reason}] — deterministic rule, capped at 25.
//     Rule 1 (low_score):      latest graded session scores below the PER-ENGINE
//                              threshold (objective vs ai_judged bucket, never
//                              cross-averaged).
//     Rule 2 (did_not_finish): the student has a stranded attempt — an expired
//                              session, or an in_progress session past its
//                              deadlineAt or the assessment's closesAt.
//     Rule 3 (not_active):     enrollment status is 'registered' (not yet 'active').
//     A student appears once; precedence low_score > did_not_finish > not_active.
router.get('/cohorts/:cohortId/analytics', institutionAuth, async (req, res) => {
  try {
    const scope = institutionScope(req);
    const { cohortId } = req.params;

    const CohortRollup = getCohortRollupModel();
    const AssessmentSession = getAssessmentSessionModel();
    const InstitutionEnrollment = getEnrollmentModel();
    const User = getUserModel();

    // ── 1. Competencies from latest cohort-wide rollup ────────────────────────
    // assessmentId: null → cohort-wide rollup (same convention used elsewhere).
    // We sort by computedAt descending to get the latest; if findOne returns a
    // plain object (stub), we just await it directly.
    let rollupQuery = CohortRollup.findOne({ ...scope, cohortId, assessmentId: null });
    if (rollupQuery && typeof rollupQuery.sort === 'function') {
      rollupQuery = rollupQuery.sort({ computedAt: -1 });
    }
    const rollup = typeof rollupQuery.lean === 'function'
      ? await rollupQuery.lean()
      : await rollupQuery;

    const rawByComp = (rollup && rollup.byCompetency) || [];
    // Sort ascending by avgScore — weakest competency first
    const competencies = [...rawByComp].sort((a, b) => (a.avgScore ?? 0) - (b.avgScore ?? 0));

    // ── 2. At-risk students ───────────────────────────────────────────────────
    // Fetch ALL sessions for this cohort (not just graded) so we can also catch
    // students who never finished (expired / stranded in_progress).
    const AssessmentModel = getAssessmentModel();
    const sessionsQuery = AssessmentSession.find({ ...scope, cohortId });
    const allSessions = typeof sessionsQuery.lean === 'function'
      ? await sessionsQuery.lean()
      : await sessionsQuery;

    // closesAt per assessment — to detect an in_progress session past its window.
    const assessmentsQuery = AssessmentModel.find({ ...scope, cohortId });
    const assessmentDocs = typeof assessmentsQuery.lean === 'function'
      ? await assessmentsQuery.lean()
      : await assessmentsQuery;
    const closesAtByAssessment = {};
    for (const a of assessmentDocs) { closesAtByAssessment[String(a._id)] = a.closesAt || null; }

    const now = new Date();

    // Build maps: latest graded session (for low_score) + did-not-finish set.
    const latestGradedByUser = {};
    const didNotFinishUsers = new Set();
    for (const s of allSessions) {
      const uid = String(s.userId);
      if (s.status === 'graded') {
        const existing = latestGradedByUser[uid];
        const sAt = s.gradedAt ? new Date(s.gradedAt) : new Date(0);
        if (!existing || sAt > new Date(existing.gradedAt || 0)) latestGradedByUser[uid] = s;
      } else if (s.status === 'expired') {
        didNotFinishUsers.add(uid);
      } else if (s.status === 'in_progress') {
        const past = (s.deadlineAt && now > new Date(s.deadlineAt))
          || (closesAtByAssessment[String(s.assessmentId)] && now > new Date(closesAtByAssessment[String(s.assessmentId)]));
        if (past) didNotFinishUsers.add(uid);
      }
    }

    // Fetch all non-withdrawn enrollments for this cohort
    const enrollmentsQuery = InstitutionEnrollment.find({ ...scope, cohortId, status: { $ne: 'withdrawn' } });
    const enrollments = typeof enrollmentsQuery.lean === 'function'
      ? await enrollmentsQuery.lean()
      : await enrollmentsQuery;

    // Build set of userIds we need to look up
    const atRiskEntries = [];
    const seenUserIds = new Set();

    for (const enrollment of enrollments) {
      const uid = String(enrollment.userId);
      if (!uid || seenUserIds.has(uid)) continue;

      let reason = null;

      // Rule 1: latest graded session below the PER-ENGINE threshold.
      const latestSession = latestGradedByUser[uid];
      if (latestSession && typeof latestSession.result?.score === 'number') {
        const method = scoreMethodForEngine(latestSession.engine && latestSession.engine.type);
        const threshold = AT_RISK_THRESHOLDS[method] != null ? AT_RISK_THRESHOLDS[method] : 40;
        if (latestSession.result.score < threshold) reason = 'low_score';
      }

      // Rule 2: stranded/abandoned attempt.
      if (!reason && didNotFinishUsers.has(uid)) reason = 'did_not_finish';

      // Rule 3: enrollment not yet active
      if (!reason && enrollment.status === 'registered') {
        reason = 'not_active';
      }

      if (reason) {
        seenUserIds.add(uid);
        atRiskEntries.push({ userId: uid, rollNumber: enrollment.rollNumber || undefined, reason });
      }
    }

    // Cap at 25
    const cappedEntries = atRiskEntries.slice(0, 25);

    // Batch-fetch user names
    const userIds = cappedEntries.map((e) => e.userId);
    let userById = {};
    if (userIds.length > 0) {
      const usersQuery = User.find({ _id: { $in: userIds } }, { firstName: 1, lastName: 1 });
      const userDocs = typeof usersQuery.lean === 'function'
        ? await usersQuery.lean()
        : await usersQuery;
      for (const u of userDocs) { userById[String(u._id)] = u; }
    }

    const atRisk = cappedEntries.map((e) => {
      const u = userById[e.userId];
      const studentName = u ? [u.firstName, u.lastName].filter(Boolean).join(' ').trim() : e.userId;
      const entry = { studentName, reason: e.reason };
      if (e.rollNumber) entry.rollNumber = e.rollNumber;
      return entry;
    });

    return res.status(200).json({ success: true, data: { competencies, atRisk } });
  } catch (err) {
    console.error('[institution/analytics:cohort]', err.message);
    return res.status(500).json({ success: false, message: 'Could not load cohort analytics.' });
  }
});

module.exports = router;
