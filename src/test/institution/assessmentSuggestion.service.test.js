'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildSuggestions, isCodingOriented, mapTrack } = require('../../services/institution/assessment/assessmentSuggestionService');

// ── mapTrack ──────────────────────────────────────────────────────────────────

test('mapTrack: fullstack_ai → ai_eng', () => {
  assert.strictEqual(mapTrack('fullstack_ai'), 'ai_eng');
});
test('mapTrack: software → swe', () => {
  assert.strictEqual(mapTrack('software'), 'swe');
});
test('mapTrack: database → ds', () => {
  assert.strictEqual(mapTrack('database'), 'ds');
});
test('mapTrack: unknown → swe (default)', () => {
  assert.strictEqual(mapTrack('unknown_track'), 'swe');
});
test('mapTrack: undefined → swe (default)', () => {
  assert.strictEqual(mapTrack(undefined), 'swe');
});

// ── isCodingOriented ──────────────────────────────────────────────────────────

test('isCodingOriented: template with capabilityTrack is coding', () => {
  assert.strictEqual(isCodingOriented({ capabilityTrack: 'software', objectiveType: 'casual_learning', competencies: [] }), true);
});
test('isCodingOriented: upskilling objectiveType is coding (even without track)', () => {
  assert.strictEqual(isCodingOriented({ objectiveType: 'upskilling', competencies: [] }), true);
});
test('isCodingOriented: competency name "Data Structures & Algorithms" triggers coding', () => {
  const tpl = { objectiveType: 'academic_excellence', competencies: [{ name: 'Data Structures & Algorithms', category: 'core' }] };
  assert.strictEqual(isCodingOriented(tpl), true);
});
test('isCodingOriented: competency name "Communication Skills" is non-coding', () => {
  const tpl = { objectiveType: 'networking', competencies: [{ name: 'Communication Skills', category: 'soft_skill' }] };
  assert.strictEqual(isCodingOriented(tpl), false);
});
test('isCodingOriented: null template returns false', () => {
  assert.strictEqual(isCodingOriented(null), false);
});

// ── buildSuggestions: no template → generic default set ───────────────────────

test('buildSuggestions: no template returns generic aptitude MCQ + HR interview', () => {
  const cohort = { _id: 'coh1' };
  const result = buildSuggestions(cohort, null);
  assert.ok(result.note, 'should include a note when no template');
  assert.ok(Array.isArray(result.suggestions), 'suggestions should be an array');
  assert.strictEqual(result.suggestions.length, 2, 'generic set has 2 suggestions');
  const types = result.suggestions.map((s) => s.type);
  assert.ok(types.includes('mcq'), 'should include an mcq suggestion');
  assert.ok(types.includes('interview'), 'should include an interview suggestion');
  const hrInterview = result.suggestions.find((s) => s.type === 'interview');
  assert.strictEqual(hrInterview.config.interview.interviewType, 'placement_hr');
  // All suggestions carry cohortId
  result.suggestions.forEach((s) => assert.strictEqual(s.cohortId, 'coh1'));
});

// ── buildSuggestions: coding template (capabilityTrack present) ───────────────

test('buildSuggestions: coding template produces MCQ per technical competency', () => {
  const cohort = { _id: 'coh2' };
  const template = {
    _id: 'tpl1',
    label: 'SWE Placement Prep',
    objectiveType: 'interview_preparation',
    capabilityTrack: 'software',
    specifics: { targetRole: 'Software Engineer' },
    competencies: [
      { name: 'Algorithms', category: 'core', weight: 8 },
      { name: 'System Design', category: 'advanced', weight: 7 },
      { name: 'Communication', category: 'soft_skill', weight: 5 },
    ],
  };
  const { suggestions } = buildSuggestions(cohort, template);
  // MCQs for core/advanced competencies only (not soft_skill)
  const mcqs = suggestions.filter((s) => s.type === 'mcq');
  assert.strictEqual(mcqs.length, 2, 'should generate 2 MCQs (core + advanced)');
  const algorithmsMcq = mcqs.find((s) => s.title === 'Algorithms — MCQ');
  assert.ok(algorithmsMcq, 'should have Algorithms MCQ');
  assert.strictEqual(algorithmsMcq.config.mcq.topic, 'Algorithms');
  assert.strictEqual(algorithmsMcq.config.mcq.totalQuestions, 15);
  assert.strictEqual(algorithmsMcq.config.mcq.assessmentType, 'mixed');
});

test('buildSuggestions: coding template produces capstone suggestion', () => {
  const cohort = { _id: 'coh2' };
  const template = {
    _id: 'tpl1',
    label: 'SWE Prep',
    objectiveType: 'interview_preparation',
    capabilityTrack: 'software',
    specifics: { targetRole: 'Software Engineer' },
    competencies: [{ name: 'Algorithms', category: 'core', weight: 8 }],
  };
  const { suggestions } = buildSuggestions(cohort, template);
  const capstones = suggestions.filter((s) => s.type === 'capstone');
  assert.strictEqual(capstones.length, 1, 'should have exactly 1 capstone suggestion');
  const cap = capstones[0];
  assert.strictEqual(cap.config.capstone.roleTrack, 'swe');
  assert.strictEqual(cap.config.capstone.difficulty, 'medium');
  assert.strictEqual(cap.config.capstone.jobDescription, 'Software Engineer');
  assert.strictEqual(cap.cohortId, 'coh2');
});

test('buildSuggestions: coding template produces drill suggestion', () => {
  const cohort = { _id: 'coh2' };
  const template = {
    _id: 'tpl1',
    label: 'SWE Prep',
    objectiveType: 'interview_preparation',
    capabilityTrack: 'software',
    specifics: { targetRole: 'Software Engineer' },
    competencies: [{ name: 'Algorithms', category: 'core', weight: 8 }],
  };
  const { suggestions } = buildSuggestions(cohort, template);
  const drills = suggestions.filter((s) => s.type === 'drill');
  assert.strictEqual(drills.length, 1, 'should have exactly 1 drill suggestion');
  const drill = drills[0];
  assert.strictEqual(drill.config.drill.roleTrack, 'swe');
  assert.strictEqual(drill.config.drill.drillSubtype, 'decompose');
  assert.strictEqual(drill.config.drill.difficulty, 'medium');
});

test('buildSuggestions: coding template produces placement_technical interview', () => {
  const cohort = { _id: 'coh2' };
  const template = {
    _id: 'tpl1',
    label: 'SWE Prep',
    objectiveType: 'interview_preparation',
    capabilityTrack: 'software',
    specifics: { targetRole: 'Software Engineer' },
    competencies: [{ name: 'Algorithms', category: 'core', weight: 8 }],
  };
  const { suggestions } = buildSuggestions(cohort, template);
  const interviews = suggestions.filter((s) => s.type === 'interview');
  assert.strictEqual(interviews.length, 2, 'coding template: HR + technical interview');
  const types = interviews.map((i) => i.config.interview.interviewType);
  assert.ok(types.includes('placement_hr'), 'should include placement_hr');
  assert.ok(types.includes('placement_technical'), 'should include placement_technical');
});

test('buildSuggestions: coding template always includes HR interview', () => {
  const cohort = { _id: 'coh3' };
  const template = {
    _id: 'tpl2',
    label: 'AI Prep',
    objectiveType: 'upskilling',
    capabilityTrack: 'fullstack_ai',
    specifics: { targetRole: 'AI Engineer' },
    competencies: [],
  };
  const { suggestions } = buildSuggestions(cohort, template);
  const hr = suggestions.find((s) => s.type === 'interview' && s.config.interview.interviewType === 'placement_hr');
  assert.ok(hr, 'HR interview must always be present');
  assert.strictEqual(hr.reason, 'Placement readiness — behavioural round');
});

test('buildSuggestions: fullstack_ai track maps roleTrack to ai_eng', () => {
  const cohort = { _id: 'coh3' };
  const template = {
    _id: 'tpl2',
    label: 'AI Prep',
    objectiveType: 'upskilling',
    capabilityTrack: 'fullstack_ai',
    specifics: { targetRole: 'AI Engineer' },
    competencies: [],
  };
  const { suggestions } = buildSuggestions(cohort, template);
  const cap = suggestions.find((s) => s.type === 'capstone');
  assert.ok(cap, 'capstone must be present for coding track');
  assert.strictEqual(cap.config.capstone.roleTrack, 'ai_eng');
  const drill = suggestions.find((s) => s.type === 'drill');
  assert.ok(drill, 'drill must be present for coding track');
  assert.strictEqual(drill.config.drill.roleTrack, 'ai_eng');
});

// ── buildSuggestions: non-coding template ─────────────────────────────────────

test('buildSuggestions: non-coding template produces MCQs + HR interview only', () => {
  const cohort = { _id: 'coh4' };
  const template = {
    _id: 'tpl3',
    label: 'Networking Prep',
    objectiveType: 'networking',
    capabilityTrack: undefined,
    specifics: {},
    competencies: [
      { name: 'Professional Communication', category: 'core', weight: 6 },
      { name: 'Networking Etiquette', category: 'soft_skill', weight: 5 },
    ],
  };
  const { suggestions } = buildSuggestions(cohort, template);
  const types = suggestions.map((s) => s.type);
  assert.ok(!types.includes('capstone'), 'no capstone for non-coding template');
  assert.ok(!types.includes('drill'), 'no drill for non-coding template');
  // HR interview still present
  const hr = suggestions.find((s) => s.type === 'interview');
  assert.ok(hr, 'HR interview should still be present');
  // Only 1 interview (no technical)
  const allInterviews = suggestions.filter((s) => s.type === 'interview');
  assert.strictEqual(allInterviews.length, 1, 'non-coding: only 1 interview (HR)');
});

test('buildSuggestions: non-coding template MCQs only for core/advanced competencies', () => {
  const cohort = { _id: 'coh4' };
  const template = {
    _id: 'tpl3',
    label: 'Networking Prep',
    objectiveType: 'networking',
    specifics: {},
    competencies: [
      { name: 'Professional Communication', category: 'core', weight: 6 },
      { name: 'Networking Etiquette', category: 'soft_skill', weight: 5 },
    ],
  };
  const { suggestions } = buildSuggestions(cohort, template);
  const mcqs = suggestions.filter((s) => s.type === 'mcq');
  assert.strictEqual(mcqs.length, 1, 'only 1 MCQ — for the core competency only');
  assert.strictEqual(mcqs[0].config.mcq.topic, 'Professional Communication');
});

// ── all suggestions carry cohortId ────────────────────────────────────────────

test('buildSuggestions: all suggestions carry cohortId', () => {
  const cohort = { _id: 'coh5' };
  const template = {
    _id: 'tpl4',
    label: 'DB Placement',
    objectiveType: 'interview_preparation',
    capabilityTrack: 'database',
    specifics: { targetRole: 'Database Engineer' },
    competencies: [{ name: 'SQL', category: 'core', weight: 9 }],
  };
  const { suggestions } = buildSuggestions(cohort, template);
  suggestions.forEach((s) => {
    assert.strictEqual(s.cohortId, 'coh5', `suggestion type=${s.type} must carry cohortId`);
  });
});

// ── each suggestion has reason ────────────────────────────────────────────────

test('buildSuggestions: each suggestion has a non-empty reason string', () => {
  const cohort = { _id: 'coh6' };
  const template = {
    _id: 'tpl5',
    label: 'Backend Prep',
    objectiveType: 'interview_preparation',
    capabilityTrack: 'software',
    specifics: {},
    competencies: [{ name: 'Node.js', category: 'core', weight: 7 }],
  };
  const { suggestions } = buildSuggestions(cohort, template);
  suggestions.forEach((s) => {
    assert.ok(typeof s.reason === 'string' && s.reason.length > 0, `suggestion type=${s.type} must have a reason`);
  });
});
