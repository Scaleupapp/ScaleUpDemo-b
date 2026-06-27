'use strict';
const express = require('express');
const institutionAuth = require('../../middleware/institutionAuth');
const { institutionScope } = require('../../middleware/institutionScope');

const router = express.Router();
router._deps = null;

// Dependency injection helpers
function getCohortRollupModel() { return (router._deps && router._deps.CohortRollup) || require('../../models/CohortRollup'); }
function getAssessmentSessionModel() { return (router._deps && router._deps.AssessmentSession) || require('../../models/AssessmentSession'); }
function getEnrollmentModel() { return (router._deps && router._deps.InstitutionEnrollment) || require('../../models/InstitutionEnrollment'); }
function getUserModel() { return (router._deps && router._deps.User) || require('../../models/User'); }

// ── GET /cohorts/:cohortId/analytics  (any institution role, institution-scoped) ─
// Returns:
//   competencies: [{name, avgScore, n}] — from latest cohort-wide CohortRollup, sorted
//                 weakest-first (ascending avgScore).
//   atRisk: [{studentName, rollNumber?, reason}] — deterministic rule, capped at 25.
//     Rule 1 (low_score):  latest graded AssessmentSession for this cohort has
//                          result.score < 40.
//     Rule 2 (not_active): enrollment status is 'registered' (not yet 'active').
//     A student only appears once (low_score takes precedence if both apply).
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
    // Fetch all graded AssessmentSessions for this cohort (scoped to institution)
    const sessionsQuery = AssessmentSession.find({ ...scope, cohortId, status: 'graded' });
    const gradedSessions = typeof sessionsQuery.lean === 'function'
      ? await sessionsQuery.lean()
      : await sessionsQuery;

    // Build a map: userId → latest graded session (by gradedAt)
    const latestSessionByUser = {};
    for (const s of gradedSessions) {
      const uid = String(s.userId);
      const existing = latestSessionByUser[uid];
      const sAt = s.gradedAt ? new Date(s.gradedAt) : new Date(0);
      if (!existing || sAt > new Date(existing.gradedAt || 0)) {
        latestSessionByUser[uid] = s;
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

      // Rule 1: latest graded session score < 40
      const latestSession = latestSessionByUser[uid];
      if (latestSession && typeof latestSession.result?.score === 'number' && latestSession.result.score < 40) {
        reason = 'low_score';
      }

      // Rule 2: enrollment not yet active
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
