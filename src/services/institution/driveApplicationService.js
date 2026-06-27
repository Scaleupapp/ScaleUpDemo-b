'use strict';

const FIELDS = ['studentName', 'rollNumber', 'studentUserId', 'stage'];
function pick(b = {}) {
  const o = {};
  for (const k of FIELDS) if (b[k] !== undefined) o[k] = b[k];
  return o;
}

function models(deps) {
  return {
    DriveApplication: (deps && deps.DriveApplication) || require('../../models/DriveApplication'),
    DriveBookmark:    (deps && deps.DriveBookmark)    || require('../../models/DriveBookmark'),
  };
}

async function listByDrive(scope, cohortId, driveId, deps) {
  const { DriveApplication, DriveBookmark } = models(deps);

  // Fetch real applications
  const appQuery = DriveApplication.find({ ...scope, cohortId, driveId });
  const applications = typeof appQuery.lean === 'function' ? await appQuery.lean() : await appQuery;

  // Build set of studentUserIds already in applications
  const existingUserIds = new Set(
    applications
      .filter((a) => a.studentUserId)
      .map((a) => String(a.studentUserId))
  );

  // Fetch bookmarks for this drive
  const bmQuery = DriveBookmark.find({ driveId });
  const bookmarks = typeof bmQuery.lean === 'function' ? await bmQuery.lean() : await bmQuery;

  // Synthesize seeded "interested" entries for bookmarked users not already in applications
  const seededEntries = bookmarks
    .filter((bm) => !existingUserIds.has(String(bm.userId)))
    .map((bm) => ({
      studentUserId: bm.userId,
      studentName: '',
      stage: 'interested',
      _seeded: true,
    }));

  const allApplications = [...applications, ...seededEntries];

  // Build stages map
  const stages = {
    interested:  [],
    applied:     [],
    shortlisted: [],
    offered:     [],
    rejected:    [],
  };
  for (const app of allApplications) {
    const s = app.stage || 'interested';
    if (stages[s]) stages[s].push(app);
  }

  return { stages, applications: allApplications };
}

async function addApplication(scope, cohortId, driveId, body, deps) {
  const { DriveApplication } = models(deps);
  return DriveApplication.create({ ...scope, cohortId, driveId, ...pick(body) });
}

async function moveStage(scope, cohortId, driveId, id, body, deps) {
  const { DriveApplication } = models(deps);
  const app = await DriveApplication.findOneAndUpdate(
    { ...scope, cohortId, driveId, _id: id },
    { $set: { stage: body.stage } },
    { new: true }
  );
  if (!app) throw new Error('APPLICATION_NOT_FOUND');
  return app;
}

async function removeApplication(scope, cohortId, driveId, id, deps) {
  const { DriveApplication } = models(deps);
  const app = await DriveApplication.findOneAndDelete({ ...scope, cohortId, driveId, _id: id });
  if (!app) throw new Error('APPLICATION_NOT_FOUND');
  return app;
}

module.exports = { listByDrive, addApplication, moveStage, removeApplication };
