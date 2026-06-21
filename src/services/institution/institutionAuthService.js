'use strict';
const jwt = require('jsonwebtoken');
const EXPIRY = process.env.JWT_INSTITUTION_EXPIRY || '12h';

function signInstitutionToken(user) {
  return jwt.sign(
    { type: 'institution', institutionUserId: String(user._id), institutionId: String(user.institutionId), role: user.role, tokenVersion: user.tokenVersion || 0 },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: EXPIRY }
  );
}
function verifyInstitutionToken(token) {
  const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
  if (decoded.type !== 'institution') throw new Error('wrong_token_type');
  return decoded;
}
module.exports = { signInstitutionToken, verifyInstitutionToken };

// --- Magic-link auth (requestLink / verify) ---
const crypto = require('crypto');
const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 min

function _hash(raw) { return crypto.createHash('sha256').update(String(raw)).digest('hex'); }
function _mintToken() { return crypto.randomBytes(24).toString('base64url'); }

async function _findByEmail(email) {
  const InstitutionUser = require('../../models/InstitutionUser');
  return InstitutionUser.findOne({ email: String(email).toLowerCase().trim(), status: { $in: ['invited', 'active'] } }).select('+authTokenHash +authTokenExpires');
}

async function _findByToken(tokenHash) {
  const InstitutionUser = require('../../models/InstitutionUser');
  return InstitutionUser.findOne({ authTokenHash: tokenHash }).select('+authTokenHash +authTokenExpires');
}

async function _sendLink(email, token, kind) {
  const base = process.env.ORGANISER_WEB_URL || 'https://organiser.scaleupapp.club';
  const url = `${base}/auth/callback?token=${token}`;
  try {
    await require('../emailService').sendInstitutionSignInLink(email, url, kind);
  } catch (e) {
    console.warn(`[institution-auth] link email failed for ${email} (${e.message})`);
  }
  return true;
}

async function requestLink(email) {
  const user = await module.exports._findByEmail(email);
  if (!user) return { ok: true }; // do not leak existence
  const token = module.exports._mintToken();
  user.authTokenHash = module.exports._hash(token);
  user.authTokenExpires = new Date(Date.now() + TOKEN_TTL_MS);
  await user.save();
  await module.exports._sendLink(user.email, token, 'login');
  return { ok: true };
}

async function verify(rawToken) {
  const user = await module.exports._findByToken(module.exports._hash(rawToken));
  if (!user || !user.authTokenExpires || user.authTokenExpires.getTime() < Date.now()) throw new Error('TOKEN_INVALID');
  user.status = 'active';
  user.authTokenHash = null;
  user.authTokenExpires = null;
  await user.save();
  return {
    token: module.exports.signInstitutionToken(user),
    institutionUserId: String(user._id),
    institutionId: String(user.institutionId),
    role: user.role,
  };
}

Object.assign(module.exports, { _hash, _mintToken, _findByEmail, _findByToken, _sendLink, requestLink, verify, TOKEN_TTL_MS });
