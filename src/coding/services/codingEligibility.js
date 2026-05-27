'use strict';

const { mapObjectiveToRoleTrack } = require('./roleTrackMapper');

// Skill slugs that strongly indicate a SWE learner
const SWE_SKILL_SLUGS = new Set([
  'data-structures-algorithms',
  'algorithms-data-structures',
  'system-design-fundamentals',
  'system-design',
  'oop-concepts',
  'object-oriented-programming',
  'web-technologies-frameworks',
  'testing-debugging-techniques',
  'version-control-systems',
  'cloud-computing-basics',
  'software-engineering',
  'programming-fundamentals',
  'distributed-systems',
  'databases-sql',
  'rest-apis',
  'microservices',
  'devops',
  'backend-development',
  'frontend-development',
  'fullstack-development',
  'mobile-development',
]);

// Skill slugs that strongly indicate a DS learner
const DS_SKILL_SLUGS = new Set([
  'statistics',
  'statistics-probability',
  'data-analysis',
  'data-visualization',
  'pandas',
  'numpy',
  'sql-for-analytics',
  'data-wrangling',
  'feature-engineering',
  'experimentation-ab-testing',
  'business-intelligence',
  'analytics',
]);

// Skill slugs that strongly indicate an AI/ML engineer
const AI_ENG_SKILL_SLUGS = new Set([
  'machine-learning',
  'deep-learning',
  'neural-networks',
  'natural-language-processing',
  'computer-vision',
  'llms',
  'large-language-models',
  'transformers',
  'rag',
  'retrieval-augmented-generation',
  'mlops',
  'model-deployment',
  'reinforcement-learning',
  'prompt-engineering',
  'agents',
  'embeddings',
  'vector-databases',
]);

// Soft-signal keywords in topicsOfInterest / specificsCanonical.targetRole
// Lowercase substrings. ANY match counts.
const SWE_SOFT_KEYWORDS = [
  'software engineer', 'software development', 'backend', 'frontend',
  'fullstack', 'mobile dev', 'system design', 'coding', 'programming',
  'devops', 'sre', 'mock interview', 'technical skill', 'problem solving',
  'sde', 'swe',
];
const DS_SOFT_KEYWORDS = [
  'data scientist', 'data science', 'data analyst', 'data analysis',
  'analytics', 'statistics', 'sql', 'pandas',
];
const AI_ENG_SOFT_KEYWORDS = [
  'ml engineer', 'machine learning engineer', 'ai engineer',
  'ml ops', 'mlops', 'llm', 'prompt engineering', 'rag', 'agent',
];

// Need at least 2 coding skill ratings to trust the signal
const MIN_SKILL_SIGNALS = 2;

/**
 * Infer a role_track from topicSelfRatings keys.
 * Returns 'swe' | 'ds' | 'ai_eng' | null.
 * Pure function — exposed for testing.
 *
 * @param {object|null} topicSelfRatings
 * @returns {string|null}
 */
function inferTrackFromSkillRatings(topicSelfRatings) {
  if (!topicSelfRatings || typeof topicSelfRatings !== 'object') return null;
  const keys = Object.keys(topicSelfRatings);
  const sweCount = keys.filter(k => SWE_SKILL_SLUGS.has(k)).length;
  const dsCount  = keys.filter(k => DS_SKILL_SLUGS.has(k)).length;
  const aiCount  = keys.filter(k => AI_ENG_SKILL_SLUGS.has(k)).length;

  // Pick the highest; ties go swe > ai_eng > ds (broadest user base wins ties)
  const maxCount = Math.max(sweCount, dsCount, aiCount);
  if (maxCount < MIN_SKILL_SIGNALS) return null;
  if (sweCount === maxCount) return 'swe';
  if (aiCount  === maxCount) return 'ai_eng';
  if (dsCount  === maxCount) return 'ds';
  return null;
}

/**
 * Infer a role_track from free-text strings (topicsOfInterest + targetRole).
 * Returns 'swe' | 'ds' | 'ai_eng' | null.
 * Pure function — exposed for testing.
 *
 * @param {string[]} texts - array of free-text strings
 * @returns {string|null}
 */
function inferTrackFromSoftKeywords(texts) {
  if (!Array.isArray(texts) || texts.length === 0) return null;
  const blob = texts.filter(Boolean).join(' ').toLowerCase();
  if (!blob) return null;

  const sweMatches = SWE_SOFT_KEYWORDS.filter(kw => blob.includes(kw)).length;
  const dsMatches  = DS_SOFT_KEYWORDS.filter(kw  => blob.includes(kw)).length;
  const aiMatches  = AI_ENG_SOFT_KEYWORDS.filter(kw => blob.includes(kw)).length;

  const max = Math.max(sweMatches, dsMatches, aiMatches);
  if (max === 0) return null;
  if (sweMatches === max) return 'swe';
  if (aiMatches  === max) return 'ai_eng';
  if (dsMatches  === max) return 'ds';
  return null;
}

/**
 * Main entry. Returns { eligible: boolean, role_track: 'swe'|'ds'|'ai_eng'|null, signal: string }
 * `signal` tells the caller WHY this user was selected (useful for analytics + debugging).
 *
 * Signals checked in priority order:
 *   A. canonicalTopic  — highest fidelity (explicit user selection)
 *   B. topicSelfRatings — very strong (learner self-declared skills, ≥2 signals required)
 *   C. topicsOfInterest + specificsCanonical.targetRole — softer keyword match
 *
 * @param {object|null} objective - the UserObjective document (lean object is fine)
 * @returns {{ eligible: boolean, role_track: string|null, signal: string }}
 */
function evaluateCodingEligibility(objective) {
  if (!objective) return { eligible: false, role_track: null, signal: 'no_objective' };

  // Signal A — canonicalTopic (highest fidelity)
  const fromTopic = mapObjectiveToRoleTrack(objective.canonicalTopic);
  if (fromTopic) return { eligible: true, role_track: fromTopic, signal: 'canonical_topic' };

  // Signal B — topicSelfRatings (very strong; learner self-declared skills)
  const fromSkills = inferTrackFromSkillRatings(objective.topicSelfRatings);
  if (fromSkills) return { eligible: true, role_track: fromSkills, signal: 'skill_ratings' };

  // Signal C — topicsOfInterest + specificsCanonical.targetRole (softer keyword match)
  const softTexts = [
    ...(objective.topicsOfInterest || []),
    objective.specificsCanonical && objective.specificsCanonical.targetRole,
  ].filter(Boolean);
  const fromSoft = inferTrackFromSoftKeywords(softTexts);
  if (fromSoft) return { eligible: true, role_track: fromSoft, signal: 'soft_keywords' };

  return { eligible: false, role_track: null, signal: 'no_match' };
}

module.exports = {
  evaluateCodingEligibility,
  inferTrackFromSkillRatings,
  inferTrackFromSoftKeywords,
  SWE_SKILL_SLUGS,
  DS_SKILL_SLUGS,
  AI_ENG_SKILL_SLUGS,
};
