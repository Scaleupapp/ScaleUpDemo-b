'use strict';
function models(deps) {
  return {
    outcomeService: (deps && deps.outcomeService) || require('./outcomeService'),
    Enrollment: (deps && deps.InstitutionEnrollment) || require('../../models/InstitutionEnrollment'),
    Drive: (deps && deps.PlacementDrive) || require('../../models/PlacementDrive'),
    Assessment: (deps && deps.Assessment) || require('../../models/Assessment'),
    pendingRostersCount: (deps && deps.pendingRostersCount) || (async (scope) => {
      const RosterUpload = require('../../models/RosterUpload');
      try { return await RosterUpload.countDocuments({ ...scope, status: 'pending' }); } catch (e) { return 0; }
    }),
    now: (deps && deps.now) || new Date(),
  };
}
async function build(scope, deps) {
  const { outcomeService, Enrollment, Drive, Assessment, pendingRostersCount, now } = models(deps);
  const out = await outcomeService.institutionOutcomes(scope, deps);
  const labelByCohort = {}; for (const c of (out.cohorts || [])) labelByCohort[String(c.cohortId)] = c.label;
  const [invited, registered, diagnosticDone, active] = await Promise.all([
    Enrollment.countDocuments({ ...scope, status: 'invited' }),
    Enrollment.countDocuments({ ...scope, status: 'registered' }),
    Enrollment.countDocuments({ ...scope, status: 'diagnostic_done' }),
    Enrollment.countDocuments({ ...scope, status: 'active' }),
  ]);
  const funnel = { invited, registered, diagnosticDone, active, placed: (out.institution && out.institution.placedCount) || 0 };
  const dq = Drive.find({ ...scope });
  const allDrives = typeof dq.lean === 'function' ? await dq.lean() : await dq;
  const future = allDrives.filter((d) => d.driveDate && new Date(d.driveDate) >= now)
    .sort((a, b) => new Date(a.driveDate) - new Date(b.driveDate));
  const upcomingDrives = future.slice(0, 6).map((d) => ({ _id: d._id, name: d.name, role: d.role, package: d.package, driveDate: d.driveDate, status: d.status, cohortLabel: labelByCohort[String(d.cohortId)] }));
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const drivesThisWeek = future.filter((d) => new Date(d.driveDate) - now <= weekMs).length;
  const configuredAssessments = await Assessment.countDocuments({ ...scope, status: 'configured' });
  const pendingRosters = await pendingRostersCount(scope);
  return { outcomes: out.institution, funnel, upcomingDrives, attention: { configuredAssessments, pendingRosters, drivesThisWeek } };
}
module.exports = { build };
