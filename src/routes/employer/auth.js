// src/routes/employer/auth.js
'use strict';
const router = require('express').Router();
const svc = require('../../services/employer/employerAuthService');

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

router.post('/signup', signupHandler);
router.post('/verify', verifyHandler);
router.post('/login', loginHandler);
router.post('/complete', completeHandler);

module.exports = router;
module.exports.signupHandler = signupHandler;
module.exports.verifyHandler = verifyHandler;
module.exports.loginHandler = loginHandler;
module.exports.completeHandler = completeHandler;
module.exports._svc = svc;
