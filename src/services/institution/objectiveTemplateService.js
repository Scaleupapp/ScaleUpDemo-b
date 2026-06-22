'use strict';
// ObjectiveTemplate CRUD — every query merges the passed `scope` ({ institutionId })
// so callers can never bypass institution isolation. `deps` is a test seam.
function getModel(deps) {
  return (deps && deps.ObjectiveTemplate) || require('../../models/ObjectiveTemplate');
}

async function createTemplate(scope, { label, objectiveType, specifics, competencies, capabilityTrack, createdBy } = {}, deps) {
  const ObjectiveTemplate = getModel(deps);
  return ObjectiveTemplate.create({ ...scope, label, objectiveType, specifics, competencies, capabilityTrack, createdBy });
}

async function listTemplates(scope, deps) {
  const ObjectiveTemplate = getModel(deps);
  return ObjectiveTemplate.find(scope).sort({ createdAt: -1 }).limit(500);
}

async function getTemplate(scope, id, deps) {
  const ObjectiveTemplate = getModel(deps);
  return ObjectiveTemplate.findOne({ ...scope, _id: id });
}

module.exports = { createTemplate, listTemplates, getTemplate };
