/**
 * Required-Time Computation Service (v2)
 *
 * v1 asks the user "how many hours/week can you commit?" — produces wish-fulfillment answers.
 * v2 computes the required hours/week from objective + timeline + current proficiency,
 * then surfaces the tradeoff honestly.
 *
 * Anchored hour estimates per objective (typical-learner baseline at intermediate level).
 * Numbers are conservative — calibrated to "average tier-2/3 college student or early-career professional."
 * Refined quarterly with real outcome data.
 *
 * Pure function — no DB calls — so it's testable and cacheable.
 */

// Baseline TOTAL hours for a typical learner to reach 80%+ readiness for each objective.
// Adjusted by current proficiency (multiplier) and surfaced as hours/week given timeline.
const BASELINE_HOURS = {
  exam_preparation: {
    cat:        { hours: 600, label: 'CAT' },
    gate:       { hours: 700, label: 'GATE' },
    upsc:       { hours: 1800, label: 'UPSC' },
    gmat:       { hours: 350, label: 'GMAT' },
    gre:        { hours: 300, label: 'GRE' },
    ielts:      { hours: 120, label: 'IELTS' },
    sbi_po:     { hours: 350, label: 'SBI PO' },
    default:    { hours: 500, label: 'competitive exam' },
  },
  interview_preparation: {
    sde:        { hours: 380, label: 'SDE interviews' },
    pm:         { hours: 280, label: 'PM interviews' },
    consulting: { hours: 260, label: 'consulting interviews' },
    data:       { hours: 320, label: 'data science interviews' },
    default:    { hours: 250, label: 'interview prep' },
  },
  career_switch: {
    service_to_product: { hours: 450, label: 'service to product engineering' },
    eng_to_pm:          { hours: 380, label: 'engineer to PM' },
    eng_to_ds:          { hours: 500, label: 'engineer to data science' },
    ic_to_manager:      { hours: 200, label: 'IC to manager' },
    default:            { hours: 350, label: 'career switch' },
  },
  upskilling: {
    ai_ml:       { hours: 500, label: 'AI/ML engineering' },
    cloud:       { hours: 250, label: 'cloud' },
    fullstack:   { hours: 400, label: 'full-stack development' },
    data_eng:    { hours: 380, label: 'data engineering' },
    cybersec:    { hours: 350, label: 'cybersecurity' },
    pm:          { hours: 280, label: 'product management' },
    default:     { hours: 300, label: 'skill mastery' },
  },
  academic_excellence: { default: { hours: 400, label: 'academic excellence' } },
  networking:          { default: { hours: 60,  label: 'networking' } },
  casual_learning:     { default: { hours: 80,  label: 'casual learning' } },
};

const PROFICIENCY_MULTIPLIER = {
  beginner:     1.00, // takes full baseline
  intermediate: 0.65, // already covers ~35% of the ground
  advanced:     0.35, // only ~35% of baseline remaining
};

const TIMELINE_WEEKS = {
  '1_month':   4,
  '3_months':  13,
  '6_months':  26,
  '1_year':    52,
  'no_deadline': 52, // treat as 12 months for computation
};

const BUFFER_FACTOR = 1.15; // 15% buffer for life events / illness / breaks

/**
 * Derives a taxonomy key from the objective's specifics. Falls back to 'default'.
 */
function deriveTaxonomyKey(objectiveType, specifics = {}) {
  const norm = (s) => (s || '').toLowerCase().trim();

  if (objectiveType === 'exam_preparation') {
    const e = norm(specifics.examName);
    if (e.includes('cat'))   return 'cat';
    if (e.includes('gate'))  return 'gate';
    if (e.includes('upsc'))  return 'upsc';
    if (e.includes('gmat'))  return 'gmat';
    if (e.includes('gre'))   return 'gre';
    if (e.includes('ielts') || e.includes('toefl')) return 'ielts';
    if (e.includes('sbi') || e.includes('ibps') || e.includes('po')) return 'sbi_po';
  }
  if (objectiveType === 'interview_preparation') {
    const r = norm(specifics.targetRole);
    if (r.includes('sde') || r.includes('software') || r.includes('developer')) return 'sde';
    if (r.includes('product manager') || r.includes('pm')) return 'pm';
    if (r.includes('consult')) return 'consulting';
    if (r.includes('data') || r.includes('analyst') || r.includes('scientist')) return 'data';
  }
  if (objectiveType === 'career_switch') {
    const from = norm(specifics.fromDomain);
    const to   = norm(specifics.toDomain);
    if (from.includes('service') && to.includes('product')) return 'service_to_product';
    if (from.includes('eng')     && to.includes('pm'))      return 'eng_to_pm';
    if (from.includes('eng')     && to.includes('data'))    return 'eng_to_ds';
    if (to.includes('manager') || to.includes('manage'))    return 'ic_to_manager';
  }
  if (objectiveType === 'upskilling') {
    const s = norm(specifics.targetSkill);
    if (s.includes('ai') || s.includes('ml') || s.includes('llm')) return 'ai_ml';
    if (s.includes('cloud') || s.includes('aws') || s.includes('azure') || s.includes('gcp')) return 'cloud';
    if (s.includes('full-stack') || s.includes('fullstack') || s.includes('web')) return 'fullstack';
    if (s.includes('data eng') || s.includes('etl')) return 'data_eng';
    if (s.includes('security') || s.includes('cyber')) return 'cybersec';
    if (s.includes('product') || s.includes('pm')) return 'pm';
  }
  return 'default';
}

/**
 * Compute required hours/week for a given objective config.
 *
 * @param {Object} args
 * @param {String} args.objectiveType - one of the seven enum values
 * @param {Object} args.specifics     - { examName, targetRole, targetSkill, fromDomain, toDomain }
 * @param {String} args.timeline      - one of the five timeline enum values
 * @param {String} args.currentLevel  - beginner | intermediate | advanced
 *
 * @returns {Object}
 *   {
 *     requiredHoursPerWeek:  Number,  // recommended weekly investment
 *     requiredHoursPerDay:   Number,  // assuming daily study
 *     totalHoursRemaining:   Number,  // total work to do
 *     timelineWeeks:         Number,
 *     baselineLabel:         String,  // human readable, "SDE interviews"
 *     paths: {
 *       commit:    { hoursPerWeek, label },
 *       lessTime:  { hoursPerWeek, timelineLabel },  // realistic alt at 60% effort
 *       moreTime:  { hoursPerWeek, timelineLabel },  // faster path at 150% effort
 *     },
 *     warnings: [String],  // honest warnings if combination is unrealistic
 *   }
 */
function computeRequiredTime({ objectiveType, specifics, timeline, currentLevel = 'beginner' }) {
  const key = deriveTaxonomyKey(objectiveType, specifics);
  const baseline =
    (BASELINE_HOURS[objectiveType] && BASELINE_HOURS[objectiveType][key]) ||
    (BASELINE_HOURS[objectiveType] && BASELINE_HOURS[objectiveType].default) ||
    { hours: 300, label: 'this goal' };

  const proficiencyMult = PROFICIENCY_MULTIPLIER[currentLevel] ?? 1.0;
  const totalHours = Math.round(baseline.hours * proficiencyMult * BUFFER_FACTOR);

  const weeks = TIMELINE_WEEKS[timeline] || 26;
  const required = Math.round(totalHours / weeks);
  const perDay = Math.round((required / 7) * 10) / 10;

  // Alt paths
  const lessTimeHrs = Math.max(Math.round(required * 0.6), 3);
  const moreTimeHrs = Math.min(Math.round(required * 1.5), 60);
  const lessTimeWeeks = Math.round(totalHours / lessTimeHrs);
  const moreTimeWeeks = Math.round(totalHours / moreTimeHrs);

  const warnings = [];
  if (required > 50)  warnings.push('That commitment is intense — burnout risk is real at this pace.');
  if (required > 70)  warnings.push('At this volume, retention drops quickly. Consider extending the timeline.');
  if (perDay > 6)     warnings.push(`Daily commitment of ${perDay} hours assumes 7-day study weeks.`);
  if (weeks <= 4 && totalHours > 100) {
    warnings.push(`In ${weeks} weeks you can realistically cover ~${Math.round((weeks * required) / totalHours * 100)}% of the syllabus at this pace.`);
  }

  return {
    requiredHoursPerWeek: required,
    requiredHoursPerDay: perDay,
    totalHoursRemaining: totalHours,
    timelineWeeks: weeks,
    baselineLabel: baseline.label,
    paths: {
      commit:    { hoursPerWeek: required,     label: `Commit: ${required} hrs/wk for ${weeks} weeks` },
      lessTime:  { hoursPerWeek: lessTimeHrs,  timelineLabel: `${lessTimeHrs} hrs/wk → about ${lessTimeWeeks} weeks` },
      moreTime:  { hoursPerWeek: moreTimeHrs,  timelineLabel: `${moreTimeHrs} hrs/wk → about ${moreTimeWeeks} weeks` },
    },
    warnings,
  };
}

module.exports = {
  computeRequiredTime,
  // exported for testing
  _internal: { deriveTaxonomyKey, BASELINE_HOURS, PROFICIENCY_MULTIPLIER, TIMELINE_WEEKS },
};
