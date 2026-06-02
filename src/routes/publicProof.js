'use strict';
const router = require('express').Router();
// express-rate-limit is not a dependency; reuse the project's existing
// codingRateLimit middleware (same pattern as coding/routes/publicProfiles.routes.js).
const rl = require('../coding/middleware/codingRateLimit');
const proofService = require('../services/readiness/proofService');

// Public, unauthenticated. IP-keyed, recruiter-friendly (120/min). Guessing a
// 16-char base64url token is infeasible.
router.get('/:token', rl({ endpoint: 'public-proof', max: 120, keyFn: (req) => req.ip || 'anon' }), async (req, res) => {
  try {
    const proof = await proofService.getPublic(req.params.token);
    if (!proof) return res.status(404).json({ success: false, message: 'This proof is no longer shared.' });
    res.json({ success: true, data: proof });
  } catch (err) {
    console.error('[publicProof]', err.message);
    res.status(500).json({ success: false, message: 'Could not load this proof.' });
  }
});

module.exports = router;
