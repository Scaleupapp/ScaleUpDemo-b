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

module.exports = { createDepartment, listDepartments, createCohort, listCohorts };
