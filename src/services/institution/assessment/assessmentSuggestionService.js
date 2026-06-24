'use strict';

/**
 * assessmentSuggestionService.js
 *
 * Builds a list of suggested Assessment payloads (ready-to-POST to POST /assessments)
 * based on a cohort's linked ObjectiveTemplate.
 *
 * Entry point: buildSuggestions(cohort, template)
 *   - cohort  : InstitutionCohort document (or plain object)
 *   - template: ObjectiveTemplate document (or null if none linked)
 *
 * Returns: { suggestions: [...], note?: string }
 *
 * Each suggestion is:
 *   { type, title, cohortId, config: { [type]: {...} }, reason }
 */

// Competency names that strongly imply coding / software work
const CODING_KEYWORDS = [
  'coding', 'programming', 'algorithm', 'data structure', 'software', 'backend',
  'frontend', 'fullstack', 'react', 'node', 'python', 'java', 'javascript',
  'typescript', 'sql', 'database', 'api', 'machine learning', 'ml', 'ai',
  'deep learning', 'data science', 'devops', 'cloud', 'system design',
];

// objectiveType values that imply SWE / DS / AI work
const CODING_OBJECTIVE_TYPES = new Set([
  'upskilling',
  'career_switch',
  'interview_preparation',
]);

/**
 * Map capabilityTrack → roleTrack used in capstone/drill config.
 */
function mapTrack(capabilityTrack) {
  const MAP = {
    fullstack_ai: 'ai_eng',
    software: 'swe',
    database: 'ds',
  };
  return MAP[capabilityTrack] || 'swe';
}

/**
 * Heuristic: is this template / competency set coding-oriented?
 */
function isCodingOriented(template) {
  if (!template) return false;
  // Explicit track is the strongest signal
  if (template.capabilityTrack) return true;
  // objectiveType implies SWE work
  if (CODING_OBJECTIVE_TYPES.has(template.objectiveType)) return true;
  // Competency name contains a coding keyword
  const competencies = template.competencies || [];
  return competencies.some((c) => {
    const lower = (c.name || '').toLowerCase();
    return CODING_KEYWORDS.some((kw) => lower.includes(kw));
  });
}

/**
 * Generic default set returned when no ObjectiveTemplate is linked.
 */
function genericSuggestions(cohortId) {
  return {
    note: 'No objective template linked to this cohort — showing generic placement readiness suggestions.',
    suggestions: [
      {
        type: 'mcq',
        title: 'Aptitude & Reasoning — MCQ',
        cohortId,
        config: {
          mcq: {
            topic: 'Aptitude & Reasoning',
            totalQuestions: 15,
            assessmentType: 'mixed',
          },
        },
        reason: 'General aptitude assessment for campus placement readiness.',
      },
      {
        type: 'interview',
        title: 'HR Interview',
        cohortId,
        config: {
          interview: {
            interviewType: 'placement_hr',
            difficulty: 'moderate',
          },
        },
        reason: 'Placement readiness — behavioural round',
      },
    ],
  };
}

/**
 * buildSuggestions(cohort, template)
 *
 * @param {object} cohort   - InstitutionCohort document
 * @param {object|null} template - ObjectiveTemplate document, or null
 * @returns {{ suggestions: object[], note?: string }}
 */
function buildSuggestions(cohort, template) {
  const cohortId = String(cohort._id || cohort.id || '');

  if (!template) {
    return genericSuggestions(cohortId);
  }

  const suggestions = [];
  const competencies = template.competencies || [];
  const coding = isCodingOriented(template);
  const roleTrack = mapTrack(template.capabilityTrack);
  const targetRole = (template.specifics && template.specifics.targetRole) || '';

  // 1. One MCQ per technical competency (core or advanced)
  for (const comp of competencies) {
    if (comp.category === 'core' || comp.category === 'advanced') {
      suggestions.push({
        type: 'mcq',
        title: `${comp.name} — MCQ`,
        cohortId,
        config: {
          mcq: {
            topic: comp.name,
            totalQuestions: 15,
            assessmentType: 'mixed',
          },
        },
        reason: `Assess ${comp.category} competency "${comp.name}" via 15-question mixed MCQ.`,
      });
    }
  }

  // 2. Coding-track extras: capstone + drill
  if (coding) {
    suggestions.push({
      type: 'capstone',
      title: `${template.label || 'Role'} — Capstone Project`,
      cohortId,
      config: {
        capstone: {
          roleTrack,
          difficulty: 'medium',
          jobDescription: targetRole,
        },
      },
      reason: `Real-world project challenge mapped to ${roleTrack} track (${targetRole || 'target role'}).`,
    });

    suggestions.push({
      type: 'drill',
      title: `${template.label || 'Role'} — Decomposition Drill`,
      cohortId,
      config: {
        drill: {
          roleTrack,
          drillSubtype: 'decompose',
          difficulty: 'medium',
        },
      },
      reason: `Problem-decomposition drill for ${roleTrack} track — builds structured thinking.`,
    });
  }

  // 3. Always: HR interview
  suggestions.push({
    type: 'interview',
    title: 'HR Interview',
    cohortId,
    config: {
      interview: {
        interviewType: 'placement_hr',
        difficulty: 'moderate',
      },
    },
    reason: 'Placement readiness — behavioural round',
  });

  // 4. Coding track: also suggest a technical interview
  if (coding) {
    suggestions.push({
      type: 'interview',
      title: 'Technical Interview',
      cohortId,
      config: {
        interview: {
          interviewType: 'placement_technical',
          difficulty: 'moderate',
          targetRole,
        },
      },
      reason: `Technical interview round for ${roleTrack} placements${targetRole ? ` (${targetRole})` : ''}.`,
    });
  }

  return { suggestions };
}

module.exports = { buildSuggestions, isCodingOriented, mapTrack };
