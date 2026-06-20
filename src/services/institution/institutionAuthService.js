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
