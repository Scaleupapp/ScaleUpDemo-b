// src/services/employer/employerAuthService.js
'use strict';
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const FREE_DOMAINS = new Set(['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'proton.me', 'protonmail.com', 'rediffmail.com']);
const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 min

function isWorkEmail(email) {
  const m = String(email || '').toLowerCase().match(/^[^@\s]+@([^@\s]+\.[^@\s]+)$/);
  if (!m) return false;
  const d = m[1];
  const tld1 = d.split('.').slice(-2).join('.');
  return !FREE_DOMAINS.has(d) && !FREE_DOMAINS.has(tld1);
}
function _hash(raw) { return crypto.createHash('sha256').update(String(raw)).digest('hex'); }
function _mintToken() { return crypto.randomBytes(24).toString('base64url'); }
function _issueJWT(account) {
  return jwt.sign({ employerId: String(account._id), type: 'employer' }, process.env.JWT_ACCESS_SECRET, { expiresIn: process.env.EMPLOYER_JWT_EXPIRY || '7d' });
}

// --- DB / IO seams (stubbable) ---
async function _upsertByEmail(email, { setOnInsert = {}, set = {} }) {
  const EmployerAccount = require('../../models/EmployerAccount');
  return EmployerAccount.findOneAndUpdate(
    { email },
    { $setOnInsert: setOnInsert, $set: set },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}
async function _findByToken(tokenHash) {
  const EmployerAccount = require('../../models/EmployerAccount');
  return EmployerAccount.findOne({ authTokenHash: tokenHash });
}
async function _save(account) { return account.save(); }
async function _sendEmail(email, token, kind) {
  // PILOT: send a magic link. Replace with a real mailer when scaling.
  // NOTE: token is intentionally NOT logged — log access must not grant auth.
  console.log(`[employer-auth] ${kind} link issued for ${email}`);
  return true;
}

async function signup({ email, companyName, name, title, linkedIn }) {
  email = String(email || '').toLowerCase().trim();
  if (!isWorkEmail(email)) throw new Error('WORK_EMAIL_REQUIRED');
  const token = _mintToken();
  await module.exports._upsertByEmail(email, {
    setOnInsert: { companyName, name, title, linkedIn },
    set: { authTokenHash: _hash(token), authTokenExpires: new Date(Date.now() + TOKEN_TTL_MS) },
  });
  await module.exports._sendEmail(email, token, 'verify');
  return { ok: true };
}

async function verifyEmail(rawToken) {
  const acc = await module.exports._findByToken(_hash(rawToken));
  if (!acc || !acc.authTokenExpires || acc.authTokenExpires.getTime() < Date.now()) throw new Error('TOKEN_INVALID');
  acc.emailVerified = true;
  acc.authTokenHash = null;
  acc.authTokenExpires = null;
  await module.exports._save(acc);
  return { jwt: _issueJWT(acc), employerId: String(acc._id), approvalStatus: acc.approvalStatus };
}

// Magic-link login for a returning employer.
async function requestLogin(email) {
  email = String(email || '').toLowerCase().trim();
  const EmployerAccount = require('../../models/EmployerAccount');
  const acc = await EmployerAccount.findOne({ email });
  if (!acc) return { ok: true }; // do not leak existence
  const token = _mintToken();
  acc.authTokenHash = _hash(token);
  acc.authTokenExpires = new Date(Date.now() + TOKEN_TTL_MS);
  await module.exports._save(acc);
  await module.exports._sendEmail(email, token, 'login');
  return { ok: true };
}
async function completeLogin(rawToken) {
  const acc = await module.exports._findByToken(_hash(rawToken));
  if (!acc || !acc.authTokenExpires || acc.authTokenExpires.getTime() < Date.now()) throw new Error('TOKEN_INVALID');
  acc.authTokenHash = null; acc.authTokenExpires = null;
  if (!acc.emailVerified) acc.emailVerified = true;
  await module.exports._save(acc);
  return { jwt: _issueJWT(acc), employerId: String(acc._id), approvalStatus: acc.approvalStatus };
}

module.exports = {
  isWorkEmail, signup, verifyEmail, requestLogin, completeLogin,
  _hash, _mintToken, _issueJWT, _upsertByEmail, _findByToken, _save, _sendEmail,
};
