'use strict';
const { verifyInstitutionToken } = require('../services/institution/institutionAuthService');

async function _loadUser(institutionUserId) {
  const InstitutionUser = require('../models/InstitutionUser');
  return InstitutionUser.findById(institutionUserId).select('institutionId role status tokenVersion scope').lean();
}

async function institutionAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ success: false, message: 'Institution token required' });
  try {
    const decoded = verifyInstitutionToken(header.split(' ')[1]);
    const user = await module.exports._loadUser(decoded.institutionUserId);
    if (!user || user.status === 'disabled') return res.status(401).json({ success: false, message: 'Account inactive' });
    if (user.tokenVersion !== decoded.tokenVersion) return res.status(401).json({ success: false, message: 'Session expired' });
    req.institution = { institutionUserId: String(user._id), institutionId: String(user.institutionId), role: user.role, scope: user.scope || { departmentIds: [] } };
    return next();
  } catch (e) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}

institutionAuth._loadUser = _loadUser;
module.exports = institutionAuth;
