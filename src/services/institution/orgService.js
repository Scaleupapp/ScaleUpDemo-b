'use strict';
// orgService — Departments + Cohorts CRUD
// Every query merges the passed `scope` object (which contains institutionId)
// so callers can never bypass institution isolation.
// deps? is an optional injection seam used by tests.

function getModels(deps) {
  if (deps) return deps;
  return {
    Department: require('../../models/Department'),
    InstitutionCohort: require('../../models/InstitutionCohort'),
    ObjectiveTemplate: require('../../models/ObjectiveTemplate'),
  };
}

/**
 * Create a Department scoped to the institution.
 * @param {object} scope  - { institutionId }
 * @param {object} payload - { name, code, capabilityTracks }
 * @param {object} [deps]  - optional { Department }
 */
async function createDepartment(scope, { name, code, capabilityTracks } = {}, deps) {
  const { Department } = getModels(deps);
  return Department.create({ ...scope, name, code, capabilityTracks });
}

/**
 * List all Departments for the institution.
 * @param {object} scope  - { institutionId }
 * @param {object} [deps]
 */
async function listDepartments(scope, deps) {
  const { Department } = getModels(deps);
  return Department.find(scope).limit(1000);
}

/**
 * Create a Cohort.  First verifies the department belongs to the institution.
 * Throws Error('DEPARTMENT_NOT_FOUND') if the department is not found in the scoped lookup.
 * @param {object} scope   - { institutionId }
 * @param {object} payload - { departmentId, year, label, placementSeason }
 * @param {object} [deps]
 */
async function createCohort(scope, { departmentId, year, label, placementSeason, objectiveTemplateId } = {}, deps) {
  const { Department, InstitutionCohort, ObjectiveTemplate } = getModels(deps);

  // Verify the department belongs to this institution (scoped lookup)
  const dept = await Department.findOne({ ...scope, _id: departmentId });
  if (!dept) {
    throw new Error('DEPARTMENT_NOT_FOUND');
  }

  // If an objective is provided at creation, verify it belongs to this institution.
  if (objectiveTemplateId) {
    const Tpl = ObjectiveTemplate || require('../../models/ObjectiveTemplate');
    const tpl = await Tpl.findOne({ ...scope, _id: objectiveTemplateId });
    if (!tpl) {
      throw new Error('TEMPLATE_NOT_FOUND');
    }
  }

  return InstitutionCohort.create({ ...scope, departmentId, year, label, placementSeason, objectiveTemplateId });
}

/**
 * List Cohorts for the institution, optionally filtered by departmentId.
 * @param {object} scope    - { institutionId }
 * @param {object} [filters] - { departmentId? }
 * @param {object} [deps]
 */
async function listCohorts(scope, { departmentId } = {}, deps) {
  const { InstitutionCohort } = getModels(deps);
  return InstitutionCohort.find({ ...scope, ...(departmentId ? { departmentId } : {}) }).limit(1000);
}

/**
 * Update a cohort's placement-season timeline (and optionally its label).
 * Scoped to the institution so a TPO cannot touch another institution's cohorts.
 * @param {object} scope    - { institutionId }
 * @param {string} cohortId
 * @param {object} patch    - { placementSeason?: { startDate?, endDate? }, label? }
 * @param {object} [deps]
 */
async function updateCohort(scope, cohortId, { placementSeason, label } = {}, deps) {
  const { InstitutionCohort } = getModels(deps);
  const set = {};
  if (placementSeason !== undefined) {
    set.placementSeason = {
      startDate: placementSeason && placementSeason.startDate ? placementSeason.startDate : null,
      endDate: placementSeason && placementSeason.endDate ? placementSeason.endDate : null,
    };
  }
  if (label !== undefined) set.label = label;
  const cohort = await InstitutionCohort.findOneAndUpdate(
    { ...scope, _id: cohortId },
    { $set: set },
    { new: true },
  );
  if (!cohort) throw new Error('COHORT_NOT_FOUND');
  return cohort;
}

// ── Placement Drive methods ──────────────────────────────────────────────────

const DRIVE_FIELDS = ['name', 'role', 'package', 'driveDate', 'eligibility', 'status', 'applyLink', 'notes'];
function pickDrive(body = {}) {
  const out = {};
  for (const k of DRIVE_FIELDS) if (body[k] !== undefined) out[k] = body[k];
  return out;
}

async function createDrive(scope, cohortId, body, deps) {
  const PlacementDrive = (deps && deps.PlacementDrive) || require('../../models/PlacementDrive');
  return PlacementDrive.create({ ...scope, cohortId, ...pickDrive(body) });
}

async function listDrives(scope, cohortId, deps) {
  const PlacementDrive = (deps && deps.PlacementDrive) || require('../../models/PlacementDrive');
  return PlacementDrive.find({ ...scope, cohortId }).sort({ driveDate: 1, createdAt: 1 }).limit(500);
}

async function updateDrive(scope, cohortId, driveId, body, deps) {
  const PlacementDrive = (deps && deps.PlacementDrive) || require('../../models/PlacementDrive');
  const d = await PlacementDrive.findOneAndUpdate({ ...scope, cohortId, _id: driveId }, { $set: pickDrive(body) }, { new: true });
  if (!d) throw new Error('DRIVE_NOT_FOUND');
  return d;
}

async function deleteDrive(scope, cohortId, driveId, deps) {
  const PlacementDrive = (deps && deps.PlacementDrive) || require('../../models/PlacementDrive');
  const d = await PlacementDrive.findOneAndDelete({ ...scope, cohortId, _id: driveId });
  if (!d) throw new Error('DRIVE_NOT_FOUND');
  return d;
}

module.exports = { createDepartment, listDepartments, createCohort, listCohorts, updateCohort, createDrive, listDrives, updateDrive, deleteDrive };
