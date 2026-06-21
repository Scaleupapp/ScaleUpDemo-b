// src/routes/institution/auth.js
'use strict';
const router = require('express').Router();
const svc = require('../../services/institution/institutionAuthService');
const rateLimiter = require('../../middleware/rateLimiter');

// Rate limiters mirroring employer auth routes
const registerLimiter = rateLimiter({ windowMs: 60 * 60 * 1000, max: 5,  keyPrefix: 'rl:institution:register' }); // 5 per hour
const requestLinkLimiter = rateLimiter({ windowMs: 15 * 60 * 1000, max: 10, keyPrefix: 'rl:institution:login' });   // 10 per 15 min

async function registerHandler(req, res) {
  try { return res.status(200).json({ success: true, data: await svc.registerInstitution(req.body || {}) }); }
  catch (err) {
    console.error('[institution/register]', err.message);
    return res.status(500).json({ success: false, message: 'Could not register institution.' });
  }
}

async function requestLinkHandler(req, res) {
  try { return res.status(200).json({ success: true, data: await svc.requestLink((req.body || {}).email) }); }
  catch (err) {
    console.error('[institution/request-link]', err.message);
    return res.status(500).json({ success: false, message: 'Could not send link.' });
  }
}

async function verifyHandler(req, res) {
  try { return res.status(200).json({ success: true, data: await svc.verify((req.body || {}).token) }); }
  catch (err) {
    if (err.message === 'TOKEN_INVALID') return res.status(400).json({ success: false, code: 'TOKEN_INVALID', message: 'This link is invalid or expired.' });
    console.error('[institution/verify]', err.message);
    return res.status(500).json({ success: false, message: 'Could not verify.' });
  }
}

router.post('/register',     registerLimiter,    registerHandler);
router.post('/request-link', requestLinkLimiter, requestLinkHandler);
router.post('/verify',                           verifyHandler);

module.exports = router;
module.exports.registerHandler    = registerHandler;
module.exports.requestLinkHandler = requestLinkHandler;
module.exports.verifyHandler      = verifyHandler;
module.exports._svc = svc;
