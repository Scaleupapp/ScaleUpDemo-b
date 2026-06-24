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

// ── rankSuggestions (optional LLM enrichment) ────────────────────────────────

/**
 * Ask the LLM to (a) re-order suggestions by placement-readiness priority for
 * this cohort and (b) rewrite each suggestion's `reason` to be specific to the
 * cohort's objective.
 *
 * Falls back to the original rule-based order on ANY error (LLM unavailable,
 * bad JSON, etc.) so it never breaks the suggestions endpoint.
 *
 * @param {object[]} suggestions - from buildSuggestions (may be empty)
 * @param {object}   cohort      - InstitutionCohort document
 * @param {object|null} template - ObjectiveTemplate document or null
 * @param {object}   deps        - injectable { llm? }
 *   deps.llm must be a function: async (prompt: string) => parsedObject|string
 *   Defaults to aiProvider.analyzeWithClaude (primary) or generateWithGPT (fallback).
 * @returns {Promise<object[]>} ranked suggestions (never throws)
 */
async function rankSuggestions(suggestions, cohort, template, deps = {}) {
  if (!suggestions || suggestions.length === 0) return suggestions;

  try {
    // Resolve LLM function
    let llmFn = deps.llm;
    if (!llmFn) {
      const aiProvider = require('../../../config/aiProvider');
      llmFn = aiProvider.analyzeWithClaude || aiProvider.generateWithGPT;
    }
    if (!llmFn) return suggestions;

    const cohortObjective = template
      ? `${template.label || template.objectiveType || 'placement'} (${template.objectiveType || ''})`
      : 'general placement readiness';

    const numberedList = suggestions
      .map((s, i) => `${i + 1}. [${s.type}] "${s.title}" — ${s.reason}`)
      .join('\n');

    const prompt = [
      `You are a placement coordinator assistant. A college cohort has the objective: "${cohortObjective}".`,
      `Below are ${suggestions.length} assessment suggestions (numbered):`,
      '',
      numberedList,
      '',
      'Return a JSON object with a single key "ranked" whose value is an array of objects.',
      'Each object must have: "index" (1-based original position, integer) and "reason" (improved, cohort-specific string).',
      'Order the array from highest to lowest placement-readiness priority for this cohort.',
      'Return ONLY valid JSON, no extra text.',
      'Example: {"ranked": [{"index": 2, "reason": "..."}, {"index": 1, "reason": "..."}]}',
    ].join('\n');

    const raw = await llmFn(prompt);

    // raw may be a parsed object or a string containing JSON
    let parsed;
    if (typeof raw === 'string') {
      // Strip markdown code fences if present
      const clean = raw.replace(/```(?:json)?\n?/g, '').replace(/```/g, '').trim();
      parsed = JSON.parse(clean);
    } else {
      parsed = raw;
    }

    if (!parsed || !Array.isArray(parsed.ranked)) return suggestions;

    const ranked = parsed.ranked;
    const result = [];
    for (const entry of ranked) {
      const idx = Number(entry.index) - 1; // convert 1-based to 0-based
      if (idx < 0 || idx >= suggestions.length) continue;
      const original = suggestions[idx];
      result.push({
        ...original,
        reason: typeof entry.reason === 'string' && entry.reason.trim()
          ? entry.reason.trim()
          : original.reason,
      });
    }

    // If we got a valid re-ordering (covers all suggestions), use it.
    // Otherwise fall back to the original order to avoid partial lists.
    if (result.length === suggestions.length) return result;
    return suggestions;
  } catch (_err) {
    // Any failure — LLM timeout, bad JSON, network error — returns original
    return suggestions;
  }
}

module.exports = { buildSuggestions, isCodingOriented, mapTrack, rankSuggestions };
