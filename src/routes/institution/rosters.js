'use strict';
const express = require('express');
const institutionAuth = require('../../middleware/institutionAuth');
const { institutionScope, requireInstitutionRole } = require('../../middleware/institutionScope');
const { validateRoster } = require('../../services/institution/rosterValidationService');
const rosterService = require('../../services/institution/rosterService');
const inviteService = require('../../services/institution/inviteService');

const router = express.Router();

// ── Dependency injection seam (used in tests to stub models) ────────────────
// Production: null → real models are required inline.
// Tests: set `rosters._deps = { Institution, RosterUpload }` before the call.
router._deps = null;

function getModels() {
  if (router._deps) return router._deps;
  return {
    Institution: require('../../models/Institution'),
    RosterUpload: require('../../models/RosterUpload'),
    PendingStudent: require('../../models/PendingStudent'),
    InstitutionEnrollment: require('../../models/InstitutionEnrollment'),
    InstitutionCohort: require('../../models/InstitutionCohort'),
  };
}

// ── POST /rosters/upload ─────────────────────────────────────────────────────
// Gate: tpo_head, tpo_coordinator
// Validates rows, persists a RosterUpload (status: validated), returns preview.
// Does NOT create PendingStudents — that happens at approve time.
router.post(
  '/rosters/upload',
  institutionAuth,
  requireInstitutionRole('tpo_head', 'tpo_coordinator'),
  async (req, res) => {
    try {
      const { Institution, RosterUpload } = getModels();
      const { departmentId, cohortId, rows = [] } = req.body;

      if (!departmentId || !cohortId) {
        return res.status(400).json({ success: false, message: 'departmentId and cohortId are required' });
      }

      // Compute available seats — always scoped to the institution from the token
      const scopeFilter = institutionScope(req);
      const institution = await Institution.findOne(scopeFilter);
      if (!institution) {
        return res.status(404).json({ success: false, message: 'Institution not found' });
      }
      // NOTE: seat accounting (seatsUsed increment on commit) is deferred to Plan 2b.
      // This overflow check is therefore per-upload only (seatsUsed is not yet incremented
      // at approve time, so seatsAvailable here reflects the licence ceiling only).
      const seatsAvailable = (institution.seatsLicensed || 0) - (institution.seatsUsed || 0);

      // Validate the incoming rows
      const { validRows, errors, counts } = validateRoster(rows, { seatsAvailable });

      // Persist the upload record (validData stored with select:false for approve step)
      const rosterUpload = new RosterUpload({
        ...institutionScope(req),
        departmentId,
        cohortId,
        uploadedBy: req.institution.institutionUserId,
        rowCount: rows.length,
        validRows: validRows.length,
        errors,
        validData: validRows,
        status: 'validated',
      });
      await rosterUpload.save();

      return res.status(201).json({
        success: true,
        data: {
          rosterUploadId: rosterUpload._id,
          counts,
          errors,
          preview: validRows,
        },
      });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  }
);

// ── GET /rosters/pending ─────────────────────────────────────────────────────
// Gate: institution_admin, tpo_head (the approvers — maker-checker).
// Lists validated-but-not-yet-approved roster uploads for the institution so an
// approver can act on an upload made in a different session or by a different
// user (e.g. a coordinator uploaded; a head/admin approves later). Excludes the
// heavy validData blob (select:false); returns enough to decide and approve.
router.get(
  '/rosters/pending',
  institutionAuth,
  requireInstitutionRole('institution_admin', 'tpo_head'),
  async (req, res) => {
    try {
      const { RosterUpload } = getModels();
      const uploads = await RosterUpload
        .find(institutionScope(req, { status: 'validated' }))
        .select('departmentId cohortId rowCount validRows errors uploadedBy createdAt')
        .sort({ createdAt: -1 })
        .limit(200);
      return res.status(200).json({ success: true, data: uploads });
    } catch (err) {
      console.error('[institution/rosters:pending]', err.message);
      return res.status(500).json({ success: false, message: 'Could not list pending uploads.' });
    }
  }
);

// ── POST /rosters/:id/approve ────────────────────────────────────────────────
// Gate: tpo_head, institution_admin  (maker-checker: different roles than upload)
// Loads the scoped RosterUpload (with validData), commits via commitRoster,
// then sends invites via sendInvites, marks the upload approved.
router.post(
  '/rosters/:id/approve',
  institutionAuth,
  requireInstitutionRole('tpo_head', 'institution_admin'),
  async (req, res) => {
    try {
      const { RosterUpload, Institution } = getModels();
      const uploadId = req.params.id;

      // Load the upload scoped to this institution
      const rosterUpload = await RosterUpload
        .findOne(institutionScope(req, { _id: uploadId }))
        .select('+validData');

      if (!rosterUpload) {
        return res.status(404).json({ success: false, message: 'Roster upload not found' });
      }
      if (rosterUpload.status !== 'validated') {
        return res.status(409).json({
          success: false,
          message: `Cannot approve an upload with status '${rosterUpload.status}'`,
        });
      }

      // Mandatory-objective gate: a cohort must have an objective attached before
      // its students are invited, so every claimed student is seeded a locked
      // institutional objective (1B). Without it, the seed would silently no-op.
      const { InstitutionCohort } = getModels();
      const cohort = await InstitutionCohort.findOne(institutionScope(req, { _id: rosterUpload.cohortId }));
      if (!cohort || !cohort.objectiveTemplateId) {
        return res.status(409).json({
          success: false,
          code: 'NO_OBJECTIVE',
          message: 'Attach an objective to this cohort before approving its roster.',
        });
      }

      // Commit — creates PendingStudent records
      const { created, pending } = await rosterService.commitRoster({
        rosterUpload,
        validRows: rosterUpload.validData || [],
      });

      // Get institution name for invite messaging
      const institution = await Institution.findOne(institutionScope(req));
      const institutionName = institution ? institution.name : 'Your Institution';
      const baseLink = process.env.STUDENT_APP_JOIN_URL || 'https://scaleupapp.club/join';

      // Send invites (email + SMS)
      const { invited } = await inviteService.sendInvites(pending, { institutionName, baseLink });

      // Mark upload approved (status transitions away from 'validated' so a second approve returns 409)
      rosterUpload.status = 'approved';
      rosterUpload.approvedBy = req.institution.institutionUserId;
      rosterUpload.approvedAt = new Date();
      await rosterUpload.save();

      return res.status(200).json({
        success: true,
        data: { created, invited },
      });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  }
);

// ── GET /cohorts/:cohortId/funnel ────────────────────────────────────────────
// Gate: institution_admin, tpo_head, tpo_coordinator, faculty, viewer
// Returns funnel counts for the cohort, all scoped to the institution.
router.get(
  '/cohorts/:cohortId/funnel',
  institutionAuth,
  requireInstitutionRole('institution_admin', 'tpo_head', 'tpo_coordinator', 'faculty', 'viewer'),
  async (req, res) => {
    try {
      const { PendingStudent, InstitutionEnrollment } = getModels();
      const cohortId = req.params.cohortId;
      const baseScope = institutionScope(req, { cohortId });

      // Funnel: CUMULATIVE stages — each stage is a superset of the next (invited ≥ registered ≥ diagnosticDone ≥ active).
      // invited        = everyone an invite was sent to (PendingStudents in 'invited'|'claimed').
      // registered     = ALL enrollment records regardless of status (a registered student stays registered+ as they progress).
      // diagnosticDone = enrollments at 'diagnostic_done' OR 'active' (superset of active).
      // active         = enrollments at 'active' only.
      // NOTE: diagnosticDone and active will remain 0 until those enrollment status transitions
      // are wired in Plan 2a. The cumulative shape is correct once those transitions land.
      const [
        invitedCount,
        registeredCount,
        diagnosticDoneCount,
        activeCount,
      ] = await Promise.all([
        PendingStudent.countDocuments({ ...institutionScope(req), cohortId, status: { $in: ['invited', 'claimed'] } }),
        InstitutionEnrollment.countDocuments({ ...baseScope }),
        InstitutionEnrollment.countDocuments({ ...baseScope, status: { $in: ['diagnostic_done', 'active'] } }),
        InstitutionEnrollment.countDocuments({ ...baseScope, status: 'active' }),
      ]);

      const invited = invitedCount;

      return res.status(200).json({
        success: true,
        data: {
          invited,
          registered: registeredCount,
          diagnosticDone: diagnosticDoneCount,
          active: activeCount,
        },
      });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  }
);

module.exports = router;
