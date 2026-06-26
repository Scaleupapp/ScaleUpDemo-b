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

  // DUAL-context guard: if the user already has an active primary objective (a
  // personal D2C goal), keep it primary and add the institutional objective as
  // NON-primary — the persona switcher (personaResolver → needsContextChoice) lets
  // them choose which experience to see, and switching sets the right one primary.
  // Only a student with no prior primary (a pure placement student) gets the
  // institutional objective as primary, so the diagnostic scopes to it as before.
  const priorPrimary = await UserObjective.findOne({ userId, status: 'active', isPrimary: true });
  const makePrimary = !priorPrimary;
  if (makePrimary) {
    // Defensive: demote any straggler primaries so this becomes the sole primary.
    // updateMany bypasses the pre-save hook, so this causes no D2C directory churn.
    await UserObjective.updateMany({ userId, isPrimary: true }, { $set: { isPrimary: false } });
  }

  const doc = new UserObjective({
    userId,
    objectiveType: template.objectiveType,
    label: template.label,             // TPO's human label, e.g. "Software Development"
    specifics: template.specifics || {},
    timeline: 'no_deadline',           // explicit deadline lives in targetDate, not the timeline enum
    targetDate,
    currentLevel: 'intermediate',
    weeklyCommitHours: 8,
    status: 'active',
    isPrimary: makePrimary,
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

  // Auto-populate the placement student's profile from the roster/cohort so they
  // never enter it (the placement onboarding skips the education/skills steps):
  //   education = their college + branch + currently-pursuing,
  //   skills    = the objective's competencies.
  // Best-effort; fills empties only (never clobbers what the student set themselves).
  try {
    const User = deps.User || require('../../models/User');
    const u = await User.findById(userId).select('education skills');
    if (u) {
      const set = {};
      if (!Array.isArray(u.education) || u.education.length === 0) {
        const Institution = deps.Institution || require('../../models/Institution');
        const Department = deps.Department || require('../../models/Department');
        const [inst, dept] = await Promise.all([
          Institution.findById(template.institutionId || cohort.institutionId).select('name'),
          cohort.departmentId ? Department.findById(cohort.departmentId).select('name') : Promise.resolve(null),
        ]);
        const passout = cohort.placementSeason && cohort.placementSeason.endDate
          ? new Date(cohort.placementSeason.endDate).getFullYear() : undefined;
        set.education = [{
          degree: dept ? dept.name : undefined,
          institution: inst ? inst.name : undefined,
          yearOfCompletion: passout,
          currentlyPursuing: true,
        }];
      }
      if (!Array.isArray(u.skills) || u.skills.length === 0) {
        const skills = (template.competencies || [])
          .map((c) => String(c.name || '').toLowerCase().trim()).filter(Boolean).slice(0, 20);
        if (skills.length) set.skills = skills;
      }
      if (Object.keys(set).length) await User.updateOne({ _id: userId }, { $set: set });
    }
  } catch (e) { console.warn('[seed] profile backfill failed', e.message); }

  return doc;
}

module.exports = { seedObjectiveFromCohort };
