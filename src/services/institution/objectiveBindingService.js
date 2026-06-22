'use strict';
// Seeds a locked institutional UserObjective from a cohort's ObjectiveTemplate.
// Called server-side at student-bind time (see rosterClaimService). Best-effort:
// returns null (no-op) when the cohort has no template, and is idempotent per
// (user, cohort). Keeps the seeded objective out of the D2C cohort directory via
// the $locals.skipInstitutionalDirectory flag honoured by UserObjective's pre-save hook.
async function seedObjectiveFromCohort(userId, cohortId, { assignedBy = null, deps = {} } = {}) {
  if (!userId || !cohortId) return null;
  const InstitutionCohort = deps.InstitutionCohort || require('../../models/InstitutionCohort');
  const ObjectiveTemplate = deps.ObjectiveTemplate || require('../../models/ObjectiveTemplate');
  const UserObjective = deps.UserObjective || require('../../models/UserObjective');

  const cohort = await InstitutionCohort.findById(cohortId);
  if (!cohort || !cohort.objectiveTemplateId) return null;          // cohort has no preset objective
  const template = await ObjectiveTemplate.findById(cohort.objectiveTemplateId);
  if (!template) return null;

  // Idempotent: one institutional objective per (user, cohort).
  const existing = await UserObjective.findOne({ userId, 'institutionContext.cohortId': cohortId });
  if (existing) return existing;

  // Deadline injected from the cohort's placement season.
  const targetDate = cohort.placementSeason && cohort.placementSeason.endDate ? cohort.placementSeason.endDate : undefined;

  // The institutional objective is the single primary so the diagnostic scopes to it.
  // Demote any prior primaries for this (now placement) user. updateMany bypasses the
  // pre-save hook, so this causes no D2C cohort-directory churn.
  await UserObjective.updateMany({ userId, isPrimary: true }, { $set: { isPrimary: false } });

  const doc = new UserObjective({
    userId,
    objectiveType: template.objectiveType,
    specifics: template.specifics || {},
    timeline: 'no_deadline',           // explicit deadline lives in targetDate, not the timeline enum
    targetDate,
    currentLevel: 'intermediate',
    weeklyCommitHours: 8,
    status: 'active',
    isPrimary: true,
    analysis: {
      competencies: (template.competencies || []).map((c) => ({ name: c.name, weight: c.weight, category: c.category })),
      analyzedAt: new Date(),
      aiModel: 'objective_template',
    },
    institutionContext: {
      institutionId: template.institutionId || cohort.institutionId,
      cohortId,
      templateId: template._id,
      assignedBy: assignedBy || undefined,
      locked: true,
    },
  });
  doc.$locals.skipInstitutionalDirectory = true;   // keep institutional objectives out of the D2C directory
  await doc.save();
  return doc;
}

module.exports = { seedObjectiveFromCohort };
