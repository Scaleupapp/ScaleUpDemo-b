// src/middleware/employerAuth.js
'use strict';
const jwt = require('jsonwebtoken');

async function _loadAccount(employerId) {
  const EmployerAccount = require('../models/EmployerAccount');
  return EmployerAccount.findById(employerId).select('emailVerified approvalStatus').lean();
}

async function employerAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ success: false, message: 'Employer token required' });
  try {
    const decoded = jwt.verify(header.split(' ')[1], process.env.JWT_ACCESS_SECRET);
    if (decoded.type !== 'employer' || !decoded.employerId) return res.status(401).json({ success: false, message: 'Invalid employer token' });
    const acc = await module.exports._loadAccount(decoded.employerId);
    if (!acc) return res.status(401).json({ success: false, message: 'Employer no longer exists' });
    req.employer = { employerId: decoded.employerId, emailVerified: acc.emailVerified, approvalStatus: acc.approvalStatus };
    return next();
  } catch (e) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}

// Gate: only manually-approved (contact-tier) employers pass.
function requireContactTier(req, res, next) {
  if (req.employer && req.employer.approvalStatus === 'approved') return next();
  return res.status(403).json({ success: false, code: 'CONTACT_PENDING', message: 'Contact access is under review.' });
}

module.exports = { employerAuth, requireContactTier, _loadAccount };
