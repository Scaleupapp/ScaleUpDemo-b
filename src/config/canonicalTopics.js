/**
 * Canonical taxonomy used by topicCanonicalizationService to map a user's
 * free-text objective into a fixed cohort key. Each entry is keyed by its
 * canonical slug and lists the objectiveTypes it is valid for. Aliases
 * exist purely as hints to the LLM prompt — they are NOT used for exact
 * string matching (that's the LLM's job).
 *
 * Adding a new canonical topic:
 *   1. Add an entry below.
 *   2. List the objectiveTypes it applies to.
 *   3. (Optional) List a few common aliases to help the LLM choose it.
 *
 * Display names are seeded here for the CohortDirectory; the LLM-titled
 * version on the directory wins when present.
 */

const CANONICAL_TOPICS = [
  // Exam prep
  { slug: 'gmat', display: 'GMAT', objectiveTypes: ['exam_preparation'], aliases: ['gmat focus', 'gmat exam'] },
  { slug: 'gre', display: 'GRE', objectiveTypes: ['exam_preparation'], aliases: [] },
  { slug: 'cat', display: 'CAT', objectiveTypes: ['exam_preparation'], aliases: ['common admission test'] },
  { slug: 'upsc', display: 'UPSC', objectiveTypes: ['exam_preparation'], aliases: ['ias', 'civil services'] },
  { slug: 'ielts', display: 'IELTS', objectiveTypes: ['exam_preparation'], aliases: [] },
  { slug: 'toefl', display: 'TOEFL', objectiveTypes: ['exam_preparation'], aliases: [] },
  { slug: 'sat', display: 'SAT', objectiveTypes: ['exam_preparation'], aliases: [] },
  { slug: 'jee', display: 'JEE', objectiveTypes: ['exam_preparation'], aliases: ['iit-jee'] },
  { slug: 'neet', display: 'NEET', objectiveTypes: ['exam_preparation'], aliases: [] },

  // Interview prep — engineering
  { slug: 'software-engineer', display: 'Software Engineer', objectiveTypes: ['interview_preparation'], aliases: ['sde', 'swe', 'developer'] },
  { slug: 'frontend-engineer', display: 'Frontend Engineer', objectiveTypes: ['interview_preparation'], aliases: ['frontend dev', 'ui engineer'] },
  { slug: 'backend-engineer', display: 'Backend Engineer', objectiveTypes: ['interview_preparation'], aliases: ['backend dev', 'server engineer'] },
  { slug: 'mobile-engineer', display: 'Mobile Engineer', objectiveTypes: ['interview_preparation'], aliases: ['ios engineer', 'android engineer'] },
  { slug: 'devops-engineer', display: 'DevOps Engineer', objectiveTypes: ['interview_preparation'], aliases: ['sre', 'platform engineer'] },
  { slug: 'data-engineer', display: 'Data Engineer', objectiveTypes: ['interview_preparation'], aliases: [] },
  { slug: 'machine-learning-engineer', display: 'ML Engineer', objectiveTypes: ['interview_preparation'], aliases: ['ml engineer', 'mle'] },

  // Interview prep — business / data
  { slug: 'product-manager', display: 'Product Manager', objectiveTypes: ['interview_preparation'], aliases: ['pm', 'product management', 'apm'] },
  { slug: 'data-scientist', display: 'Data Scientist', objectiveTypes: ['interview_preparation'], aliases: ['ds'] },
  { slug: 'data-analyst', display: 'Data Analyst', objectiveTypes: ['interview_preparation'], aliases: [] },
  { slug: 'consultant', display: 'Consultant', objectiveTypes: ['interview_preparation'], aliases: ['management consultant', 'mbb'] },
  { slug: 'investment-banker', display: 'Investment Banker', objectiveTypes: ['interview_preparation'], aliases: ['ib', 'banking'] },

  // Admissions
  { slug: 'mba-admissions', display: 'MBA Admissions', objectiveTypes: ['interview_preparation'], aliases: ['mba'] },

  // Upskilling — broad domains
  { slug: 'system-design', display: 'System Design', objectiveTypes: ['upskilling'], aliases: ['distributed systems', 'architecture'] },
  { slug: 'machine-learning', display: 'Machine Learning', objectiveTypes: ['upskilling'], aliases: ['ml', 'deep learning'] },
  { slug: 'data-science', display: 'Data Science', objectiveTypes: ['upskilling'], aliases: [] },
  { slug: 'product-strategy', display: 'Product Strategy', objectiveTypes: ['upskilling'], aliases: ['product thinking'] },
  { slug: 'cloud-engineering', display: 'Cloud Engineering', objectiveTypes: ['upskilling'], aliases: ['aws', 'gcp', 'azure'] },
  { slug: 'cybersecurity', display: 'Cybersecurity', objectiveTypes: ['upskilling'], aliases: ['infosec', 'security'] },

  // Career switch — broad target buckets
  { slug: 'switch-to-tech', display: 'Switch to Tech', objectiveTypes: ['career_switch'], aliases: ['career change to tech'] },
  { slug: 'switch-to-product', display: 'Switch to Product', objectiveTypes: ['career_switch'], aliases: [] },
  { slug: 'switch-to-data', display: 'Switch to Data', objectiveTypes: ['career_switch'], aliases: [] },

  // Universal fallback bucket — never user-facing as a goal, but used when
  // the LLM can't find a confident match for the user's free-text input.
  { slug: 'general-learning', display: 'General Learning', objectiveTypes: ['exam_preparation', 'interview_preparation', 'upskilling', 'career_switch', 'networking', 'academic_excellence', 'casual_learning'], aliases: [] },
];

function topicsForObjectiveType(objectiveType) {
  return CANONICAL_TOPICS.filter(t => t.objectiveTypes.includes(objectiveType));
}

function findBySlug(slug) {
  if (!slug) return null;
  return CANONICAL_TOPICS.find(t => t.slug === slug) || null;
}

module.exports = { CANONICAL_TOPICS, topicsForObjectiveType, findBySlug };
