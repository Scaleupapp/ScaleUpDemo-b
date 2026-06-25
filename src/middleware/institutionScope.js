'use strict';
// Scoping is institution-level for now; department-level scoping (req.institution.scope.departmentIds) is deferred to Plan 1B.
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
    if (!req.institution) {
      return res.status(403).json({ success: false, message: 'Insufficient role' });
    }
    // institution_admin is the superset role (holds '*' permissions) — it is
    // permitted everywhere a more specific role is, so an admin always has at
    // least TPO-head-equivalent access across the portal.
    if (req.institution.role === 'institution_admin') return next();
    if (!roles.includes(req.institution.role)) {
      return res.status(403).json({ success: false, message: 'Insufficient role' });
    }
    next();
  };
}
module.exports = { institutionScope, requireInstitutionRole, can, PERMISSIONS };
