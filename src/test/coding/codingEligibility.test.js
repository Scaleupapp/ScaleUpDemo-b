'use strict';

require('dotenv').config();
process.env.OPENAI_API_KEY    = process.env.OPENAI_API_KEY    || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const {
  evaluateCodingEligibility,
  inferTrackFromSkillRatings,
  inferTrackFromSoftKeywords,
} = require('../../coding/services/codingEligibility');

// ---- inferTrackFromSkillRatings ----

test('inferTrackFromSkillRatings: null/empty input returns null', () => {
  assert.equal(inferTrackFromSkillRatings(null), null);
  assert.equal(inferTrackFromSkillRatings({}), null);
});

test('inferTrackFromSkillRatings: 1 SWE skill is below threshold', () => {
  assert.equal(inferTrackFromSkillRatings({ 'data-structures-algorithms': 'familiar' }), null);
});

test('inferTrackFromSkillRatings: 2+ SWE skills -> swe (screenshot user case)', () => {
  const ratings = {
    'data-structures-algorithms': 'familiar',
    'system-design-fundamentals': 'familiar',
    'oop-concepts': 'familiar',
    'web-technologies-frameworks': 'familiar',
  };
  assert.equal(inferTrackFromSkillRatings(ratings), 'swe');
});

test('inferTrackFromSkillRatings: DS-heavy ratings -> ds', () => {
  const ratings = {
    'statistics': 'familiar',
    'data-analysis': 'familiar',
    'pandas': 'familiar',
    'data-visualization': 'familiar',
  };
  assert.equal(inferTrackFromSkillRatings(ratings), 'ds');
});

test('inferTrackFromSkillRatings: AI-Eng heavy ratings -> ai_eng', () => {
  const ratings = {
    'machine-learning': 'familiar',
    'deep-learning': 'familiar',
    'rag': 'familiar',
    'prompt-engineering': 'familiar',
  };
  assert.equal(inferTrackFromSkillRatings(ratings), 'ai_eng');
});

test('inferTrackFromSkillRatings: SWE ties beat DS', () => {
  const ratings = {
    'data-structures-algorithms': 'familiar',
    'oop-concepts': 'familiar',
    'statistics': 'familiar',
    'pandas': 'familiar',
  };
  assert.equal(inferTrackFromSkillRatings(ratings), 'swe');
});

// ---- inferTrackFromSoftKeywords ----

test('inferTrackFromSoftKeywords: empty input returns null', () => {
  assert.equal(inferTrackFromSoftKeywords([]), null);
  assert.equal(inferTrackFromSoftKeywords(['']), null);
});

test('inferTrackFromSoftKeywords: matches SWE via topicsOfInterest', () => {
  const texts = ['system design', 'technical skills', 'mock interviews'];
  assert.equal(inferTrackFromSoftKeywords(texts), 'swe');
});

test('inferTrackFromSoftKeywords: matches DS via targetRole', () => {
  assert.equal(inferTrackFromSoftKeywords(['data scientist intern']), 'ds');
});

test('inferTrackFromSoftKeywords: matches AI Eng via "ml engineer"', () => {
  assert.equal(inferTrackFromSoftKeywords(['ml engineer at startup']), 'ai_eng');
});

// ---- evaluateCodingEligibility (E2E across signals) ----

test('evaluateCodingEligibility: null objective -> not eligible', () => {
  const r = evaluateCodingEligibility(null);
  assert.equal(r.eligible, false);
  assert.equal(r.signal, 'no_objective');
});

test('evaluateCodingEligibility: software-engineer canonicalTopic -> swe via canonical_topic', () => {
  const r = evaluateCodingEligibility({ canonicalTopic: 'software-engineer' });
  assert.equal(r.eligible, true);
  assert.equal(r.role_track, 'swe');
  assert.equal(r.signal, 'canonical_topic');
});

test('evaluateCodingEligibility: data-science canonicalTopic now maps to ds (was unmapped)', () => {
  const r = evaluateCodingEligibility({ canonicalTopic: 'data-science' });
  assert.equal(r.eligible, true);
  assert.equal(r.role_track, 'ds');
  assert.equal(r.signal, 'canonical_topic');
});

test('evaluateCodingEligibility: machine-learning canonicalTopic now maps to ai_eng', () => {
  const r = evaluateCodingEligibility({ canonicalTopic: 'machine-learning' });
  assert.equal(r.eligible, true);
  assert.equal(r.role_track, 'ai_eng');
});

test('evaluateCodingEligibility: general-learning + SWE skill ratings -> eligible via skill_ratings', () => {
  // This is the screenshot user case generalized
  const obj = {
    canonicalTopic: 'general-learning',
    topicSelfRatings: {
      'data-structures-algorithms': 'familiar',
      'system-design-fundamentals': 'familiar',
      'oop-concepts': 'familiar',
    },
  };
  const r = evaluateCodingEligibility(obj);
  assert.equal(r.eligible, true);
  assert.equal(r.role_track, 'swe');
  assert.equal(r.signal, 'skill_ratings');
});

test('evaluateCodingEligibility: general-learning + only soft keywords -> eligible via soft_keywords', () => {
  const obj = {
    canonicalTopic: 'general-learning',
    topicsOfInterest: ['system design', 'mock interviews', 'problem solving'],
  };
  const r = evaluateCodingEligibility(obj);
  assert.equal(r.eligible, true);
  assert.equal(r.role_track, 'swe');
  assert.equal(r.signal, 'soft_keywords');
});

test('evaluateCodingEligibility: GMAT objective -> not eligible (no signals match)', () => {
  const obj = {
    canonicalTopic: 'gmat',
    topicsOfInterest: ['quantitative reasoning', 'verbal'],
  };
  const r = evaluateCodingEligibility(obj);
  assert.equal(r.eligible, false);
  assert.equal(r.signal, 'no_match');
});

test('evaluateCodingEligibility: real screenshot user (software-engineer + DSA skills + softening interests)', () => {
  // Verbatim shape from prod data we pulled
  const obj = {
    canonicalTopic: 'software-engineer',
    topicsOfInterest: ['system design', 'technical skills', 'salary negotiation', 'problem solving', 'mock interviews', 'behavioral questions'],
    topicSelfRatings: {
      'data-structures-algorithms': 'familiar',
      'system-design-fundamentals': 'familiar',
      'oop-concepts': 'familiar',
      'web-technologies-frameworks': 'familiar',
    },
    specificsCanonical: { targetRole: 'Software Engineer - Test', targetCompany: 'BrowserStack' },
  };
  const r = evaluateCodingEligibility(obj);
  assert.equal(r.eligible, true);
  assert.equal(r.role_track, 'swe');
  assert.equal(r.signal, 'canonical_topic');  // canonicalTopic wins first
});
