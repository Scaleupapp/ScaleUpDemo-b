'use strict';
const express = require('express');
const institutionAuth = require('../../middleware/institutionAuth');
const { institutionScope } = require('../../middleware/institutionScope');

const router = express.Router();

// ── Dependency injection seam (used in tests to stub models) ─────────────────
// Production: null → real models are required inline.
// Tests: set `me._deps = { InstitutionUser, Institution }` before the call.
router._deps = null;

function getModels() {
  if (router._deps) return router._deps;
  return {
    InstitutionUser: require('../../models/InstitutionUser'),
    Institution: require('../../models/Institution'),
  };
}

// ── GET /me ──────────────────────────────────────────────────────────────────
// Gate: any authenticated institution user
// Returns the authenticated user and their institution details.
router.get('/', institutionAuth, async (req, res) => {
  try {
    const { InstitutionUser, Institution } = getModels();

    const [user, institution] = await Promise.all([
      InstitutionUser.findById(req.institution.institutionUserId)
        .select('name email role scope')
        .lean(),
      Institution.findOne(institutionScope(req))
        .select('name logoUrl brandColor seatsLicensed seatsUsed')
        .lean(),
    ]);

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    if (!institution) {
      return res.status(404).json({ success: false, message: 'Institution not found' });
    }

    return res.status(200).json({
      success: true,
      data: {
        user: {
          id: String(user._id),
          name: user.name,
          email: user.email,
          role: user.role,
          scope: user.scope || { departmentIds: [] },
        },
        institution: {
          id: String(institution._id),
          name: institution.name,
          logoUrl: institution.logoUrl || null,
          brandColor: institution.brandColor || null,
          seatsLicensed: institution.seatsLicensed || 0,
          seatsUsed: institution.seatsUsed || 0,
        },
      },
    });
  } catch (err) {
    console.error('[institution/me]', err.message);
    return res.status(500).json({ success: false, message: 'Could not load profile.' });
  }
});

module.exports = router;
