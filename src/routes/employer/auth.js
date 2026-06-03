// src/routes/employer/auth.js
'use strict';
const router = require('express').Router();
const svc = require('../../services/employer/employerAuthService');
const featureFlags = require('../../config/featureFlags');
const rateLimiter = require('../../middleware/rateLimiter');

// Feature-flag guard — mirrors the pattern in src/routes/v2/talent.js
function flagGuard(req, res, next) {
  if (!featureFlags.employerMarketplace) return res.status(404).json({ success: false, message: 'Not found' });
  return next();
}

// Rate limiters mirroring learner auth routes (src/routes/auth.js)
const signupLimiter = rateLimiter({ windowMs: 60 * 60 * 1000, max: 5, keyPrefix: 'rl:employer:signup' });   // 5 per hour
const loginLimiter  = rateLimiter({ windowMs: 15 * 60 * 1000, max: 10, keyPrefix: 'rl:employer:login' });   // 10 per 15 min

async function signupHandler(req, res) {
  try { return res.status(200).json({ success: true, data: await svc.signup(req.body || {}) }); }
  catch (err) {
    if (err.message === 'WORK_EMAIL_REQUIRED') return res.status(400).json({ success: false, code: 'WORK_EMAIL_REQUIRED', message: 'Please use your work email (not a personal address).' });
    console.error('[employer/signup]', err.message); return res.status(500).json({ success: false, message: 'Could not sign up.' });
  }
}
async function verifyHandler(req, res) {
  try { return res.status(200).json({ success: true, data: await svc.verifyEmail((req.body || {}).token) }); }
  catch (err) {
    if (err.message === 'TOKEN_INVALID') return res.status(400).json({ success: false, code: 'TOKEN_INVALID', message: 'This link is invalid or expired.' });
    console.error('[employer/verify]', err.message); return res.status(500).json({ success: false, message: 'Could not verify.' });
  }
}
async function loginHandler(req, res) {
  try { return res.status(200).json({ success: true, data: await svc.requestLogin((req.body || {}).email) }); }
  catch (err) { console.error('[employer/login]', err.message); return res.status(500).json({ success: false, message: 'Could not send link.' }); }
}
async function completeHandler(req, res) {
  try { return res.status(200).json({ success: true, data: await svc.completeLogin((req.body || {}).token) }); }
  catch (err) {
    if (err.message === 'TOKEN_INVALID') return res.status(400).json({ success: false, code: 'TOKEN_INVALID', message: 'This link is invalid or expired.' });
    console.error('[employer/complete]', err.message); return res.status(500).json({ success: false, message: 'Could not log in.' });
  }
}

// flagGuard is FIRST on all routes; rate limiters on the email-sending endpoints
router.post('/signup',   flagGuard, signupLimiter, signupHandler);
router.post('/verify',   flagGuard, verifyHandler);
router.post('/login',    flagGuard, loginLimiter,  loginHandler);
router.post('/complete', flagGuard, completeHandler);

module.exports = router;
module.exports.signupHandler = signupHandler;
module.exports.verifyHandler = verifyHandler;
module.exports.loginHandler = loginHandler;
module.exports.completeHandler = completeHandler;
module.exports.flagGuard = flagGuard;
module.exports._svc = svc;
