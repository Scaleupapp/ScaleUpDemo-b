'use strict';

/**
 * Public, UNAUTHENTICATED coding-profile routes. Mounted at
 * /api/coding/public in app.js (separate from the auth-gated /api/coding
 * router). The only thing exposed here is the scores-and-competency public
 * profile behind an opt-in, revocable share token.
 */

const router = require('express').Router();
const rl = require('../middleware/codingRateLimit');
const shareProfile = require('../controllers/shareProfile.controller');

// Keyed by IP (no userId on a public route). 120/min absorbs a recruiter
// refreshing; brute-forcing a 32-char base64url token is infeasible anyway.
router.get(
  '/profiles/:token',
  rl({ endpoint: 'public-profile', max: 120, keyFn: (req) => req.ip || 'anon' }),
  shareProfile.getPublicProfile
);

module.exports = router;
