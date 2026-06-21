'use strict';
const express = require('express');
const institutionAuth = require('../../middleware/institutionAuth');
const { institutionScope, requireInstitutionRole } = require('../../middleware/institutionScope');

const router = express.Router();

// ── Dependency injection seam ────────────────────────────────────────────────
// Production: null → real institutionAuthService + InstitutionUser are required inline.
// Tests: set `users._svc = { inviteUser, listUsers }` before the request.
router._svc = null;

function getInviteUser(svc) {
  if (svc && svc.inviteUser) return svc.inviteUser.bind(svc);
  return require('../../services/institution/institutionAuthService').inviteUser;
}

function getInstitutionUserModel(svc) {
  if (svc && svc.listUsers) return { findScoped: svc.listUsers };
  return null; // use real model inline
}

// ── POST /users ───────────────────────────────────────────────────────────────
// Gate: institution_admin, tpo_head
router.post(
  '/users',
  institutionAuth,
  requireInstitutionRole('institution_admin', 'tpo_head'),
  async (req, res) => {
    try {
      const inviteUser = getInviteUser(router._svc);
      const scope = institutionScope(req);
      const { email, role, scope: userScope } = req.body;
      const user = await inviteUser({
        institutionId: scope.institutionId,
        email,
        role,
        scope: userScope || {},
        invitedBy: req.institution.institutionUserId,
        invitedByRole: req.institution.role,
      });
      // Return only safe fields — NEVER authTokenHash / passwordHash / tokenVersion
      return res.status(201).json({
        success: true,
        data: {
          id: String(user._id),
          email: user.email,
          role: user.role,
          status: user.status,
        },
      });
    } catch (err) {
      if (err.message === 'FORBIDDEN_ROLE') {
        return res.status(403).json({
          success: false,
          code: 'FORBIDDEN_ROLE',
          message: 'TPO Heads cannot create Admins.',
        });
      }
      if (err.message === 'INVALID_ROLE') {
        return res.status(400).json({ success: false, code: 'INVALID_ROLE', message: 'Invalid role.' });
      }
      if (err.message === 'VALIDATION') {
        return res.status(400).json({ success: false, code: 'VALIDATION', message: 'A valid email is required.' });
      }
      if (err.code === 11000) {
        return res.status(409).json({ success: false, code: 'ALREADY_EXISTS', message: 'A user with this email already exists.' });
      }
      console.error('[institution/users:invite]', err.message);
      return res.status(500).json({ success: false, message: 'Could not invite user.' });
    }
  }
);

// ── GET /users ────────────────────────────────────────────────────────────────
// Gate: any authenticated institution role
router.get(
  '/users',
  institutionAuth,
  async (req, res) => {
    try {
      const scope = institutionScope(req);
      let users;

      const svcMock = router._svc;
      if (svcMock && svcMock.listUsers) {
        // Test stub path
        users = await svcMock.listUsers(scope.institutionId);
      } else {
        // Production path: query the real model, projecting only safe fields
        const InstitutionUser = require('../../models/InstitutionUser');
        users = await InstitutionUser
          .find({ institutionId: scope.institutionId })
          .select('name email role status')
          .limit(1000);
      }

      return res.status(200).json({ success: true, data: users });
    } catch (err) {
      console.error('[institution/users:list]', err.message);
      return res.status(500).json({ success: false, message: 'Could not list users.' });
    }
  }
);

module.exports = router;
