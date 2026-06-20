'use strict';
function institutionScope(req, extra = {}) {
  if (!req.institution || !req.institution.institutionId) throw new Error('no_institution_context');
  return { ...extra, institutionId: req.institution.institutionId };
}

const PERMISSIONS = {
  institution_admin: ['*'],
  tpo_head: ['cohort.manage', 'user.manage', 'roster.upload', 'roster.approve', 'assessment.configure', 'assessment.release', 'content.create', 'analytics.view', 'report.export'],
  tpo_coordinator: ['roster.upload', 'assessment.configure', 'content.create', 'analytics.view', 'report.export'],
  faculty: ['content.create', 'analytics.view.own', 'report.export.own'],
  viewer: ['analytics.view'],
};
function can(role, capability) {
  const perms = PERMISSIONS[role] || [];
  return perms.includes('*') || perms.includes(capability);
}
function requireInstitutionRole(...roles) {
  return (req, res, next) => {
    if (!req.institution || !roles.includes(req.institution.role)) {
      return res.status(403).json({ success: false, message: 'Insufficient role' });
    }
    next();
  };
}
module.exports = { institutionScope, requireInstitutionRole, can, PERMISSIONS };
