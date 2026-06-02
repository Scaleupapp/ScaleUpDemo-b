'use strict';

// Objective-aware outcome options. Each {key,label,maps} → a normalized label.
const SETS = {
  interview: [
    { key: 'got_role', label: 'I got the role', maps: 'SUCCESS' },
    { key: 'different_role', label: 'I got a different role', maps: 'SUCCESS' },
    { key: 'still_interviewing', label: 'Still interviewing', maps: 'PENDING' },
    { key: 'didnt_work_out', label: "It didn't work out", maps: 'NOT_SUCCESS' },
    { key: 'paused', label: 'Paused this goal', maps: 'ABANDONED' },
  ],
  exam: [
    { key: 'passed', label: 'Passed', maps: 'SUCCESS' },
    { key: 'didnt_pass', label: "Didn't pass", maps: 'NOT_SUCCESS' },
    { key: 'not_taken', label: "Haven't taken it yet", maps: 'PENDING' },
  ],
  skill: [
    { key: 'nailed_it', label: 'Nailed it', maps: 'SUCCESS' },
    { key: 'partly', label: 'Partly', maps: 'PARTIAL' },
    { key: 'not_yet', label: 'Not yet', maps: 'PENDING' },
  ],
  generic: [
    { key: 'achieved', label: 'Achieved it', maps: 'SUCCESS' },
    { key: 'somewhat', label: 'Somewhat', maps: 'PARTIAL' },
    { key: 'not_really', label: 'Not really', maps: 'NOT_SUCCESS' },
    { key: 'not_yet', label: 'Not yet', maps: 'PENDING' },
  ],
};
function setKeyFor(objectiveType) {
  switch (objectiveType) {
    case 'interview_preparation':
    case 'career_switch': return 'interview';
    case 'exam_preparation': return 'exam';
    case 'upskilling':
    case 'academic_excellence': return 'skill';
    default: return 'generic';
  }
}
function optionsFor(objectiveType) {
  return SETS[setKeyFor(objectiveType)].map(({ key, label }) => ({ key, label }));
}
function labelFor(objectiveType, rawChoice) {
  const found = SETS[setKeyFor(objectiveType)].find((o) => o.key === rawChoice);
  return found ? found.maps : null;
}

module.exports = { optionsFor, labelFor, setKeyFor };

// --- Task 4: buildContext (freeze readiness from snapshot history) ---
const ReadinessSnapshot = require('../../models/ReadinessSnapshot');
const { getEffectiveTarget, targetBands } = require('./targetService');

function _bandFor(score, bands) {
  if (score >= bands.exceptional) return 'Exceptional';
  if (score >= bands.strong) return 'Strong';
  if (score >= bands.competitive) return 'Competitive';
  return 'Developing';
}

async function buildContext(objective) {
  const snaps = await ReadinessSnapshot.find({ userId: objective.userId, objectiveId: objective._id })
    .sort({ createdAt: -1 }).lean(); // newest-first
  const latest = snaps[0] || null;
  const readinessAtCapture = latest ? latest.value : null;
  const peakReadiness = snaps.length ? Math.max(...snaps.map((s) => s.value || 0)) : null;
  let readinessAtTarget = null;
  if (objective.targetDate && snaps.length) {
    const t = new Date(objective.targetDate).getTime();
    readinessAtTarget = snaps.reduce((best, s) =>
      Math.abs(new Date(s.createdAt).getTime() - t) < Math.abs(new Date(best.createdAt).getTime() - t) ? s : best
    , snaps[0]).value;
  }
  const target = getEffectiveTarget(objective);
  const bands = targetBands(target);
  return {
    readinessAtCapture,
    targetAtCapture: target,
    bandAtCapture: readinessAtCapture != null ? _bandFor(readinessAtCapture, bands) : null,
    readinessAtTarget,
    peakReadiness,
    wasEverReady: !!objective.readyState?.isReady,
    coverageAtCapture: latest?.shadow?.coverage != null ? latest.shadow.coverage : null,
    weeksToOutcome: objective.createdAt
      ? Math.max(1, Math.round((Date.now() - new Date(objective.createdAt)) / (7 * 24 * 3600 * 1000))) : null,
  };
}

module.exports.buildContext = buildContext;

// --- Task 5: recordOutcome + isDue ---
const UserObjective = require('../../models/UserObjective');
const ObjectiveOutcome = require('../../models/ObjectiveOutcome');
const ReadinessProof = require('../../models/ReadinessProof');

const REPROMPT_DAYS = 21;
const MAX_PROMPTS = 3;

/** Should we ask for the outcome? True iff targetDate passed, not already resolved,
 *  not snoozed, and under the prompt cap. */
function isDue(objective, hasResolvedOutcome) {
  if (!objective || hasResolvedOutcome) return false;
  if (!objective.targetDate || new Date(objective.targetDate) > new Date()) return false;
  const p = objective.outcomePrompt || {};
  if (p.snoozedUntil && new Date(p.snoozedUntil) > new Date()) return false;
  if ((p.promptCount || 0) >= MAX_PROMPTS) return false;
  return true;
}

async function recordOutcome(userId, { objectiveId, rawChoice, detail, testimonial, allowTestimonialUse, source }) {
  const objective = await UserObjective.findById(objectiveId);
  if (!objective || String(objective.userId) !== String(userId)) throw new Error('OBJECTIVE_NOT_FOUND');
  const label = module.exports.labelFor(objective.objectiveType, rawChoice);
  if (!label) throw new Error('BAD_CHOICE');
  const context = await module.exports.buildContext(objective);

  await ObjectiveOutcome.create({
    userId, objectiveId, objectiveType: objective.objectiveType, label, rawChoice, detail,
    source: source || 'i_got_it', context, testimonial, allowTestimonialUse: !!allowTestimonialUse,
    resolved: label !== 'PENDING', respondedAt: new Date(),
  });

  // Clear the prompt; record the ask.
  objective.outcomePrompt = objective.outcomePrompt || {};
  objective.outcomePrompt.due = false;
  objective.outcomePrompt.lastAskedAt = new Date();
  if (label === 'SUCCESS') { objective.status = 'completed'; objective.completedAt = new Date(); }
  else if (label === 'ABANDONED') { objective.status = 'abandoned'; }
  await objective.save();

  if (label === 'SUCCESS') {
    const stamp = `✓ ACHIEVED · ${new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`;
    await ReadinessProof.updateMany(
      { userId, objectiveId, active: true },
      { $set: { achieved: true, achievedAt: new Date(), 'snapshot.achievedLabel': stamp } }
    ).catch(() => {});
  }
  return { ok: true, label, celebrate: label === 'SUCCESS' };
}

module.exports.isDue = isDue;
module.exports.recordOutcome = recordOutcome;
module.exports.REPROMPT_DAYS = REPROMPT_DAYS;
module.exports.MAX_PROMPTS = MAX_PROMPTS;
