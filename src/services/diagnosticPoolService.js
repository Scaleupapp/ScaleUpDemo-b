/**
 * Diagnostic Pool Service — generates question pools for a diagnostic attempt.
 *
 * Two responsibilities:
 *   1. Calculate the pool size + difficulty distribution given (competencies, totalSize)
 *   2. Generate the pool by combining bank lookups with live LLM calls
 *
 * This file holds the calculator. LLM/bank integration arrives in later tasks.
 */

const FLOOR_QUESTIONS_PER_COMPETENCY = 3;
const DEFAULT_POOL_SIZE = 24;

// Difficulty distribution per self-rating, expressed as proportions
// over the per-competency allocation.
const DIFFICULTY_MIX = {
  novice:     { easy: 0.60, medium: 0.25, hard: 0.15 },
  unsure:     { easy: 0.60, medium: 0.25, hard: 0.15 },
  familiar:   { easy: 0.40, medium: 0.50, hard: 0.10 },
  proficient: { easy: 0.25, medium: 0.50, hard: 0.25 },
  expert:     { easy: 0.10, medium: 0.40, hard: 0.50 },
};

/**
 * Returns one allocation entry per competency with per-difficulty integer counts.
 * Total across all competencies will be approximately `totalPoolSize`, with a
 * hard floor of FLOOR_QUESTIONS_PER_COMPETENCY per competency.
 */
function calculatePoolAllocation(competencies, totalPoolSize = DEFAULT_POOL_SIZE) {
  if (!competencies?.length) return [];
  const perCompetency = Math.max(
    FLOOR_QUESTIONS_PER_COMPETENCY,
    Math.round(totalPoolSize / competencies.length),
  );
  return competencies.map(c => {
    const mix = DIFFICULTY_MIX[c.selfRating] || DIFFICULTY_MIX.unsure;
    const easy   = Math.max(1, Math.round(perCompetency * mix.easy));
    const hard   = Math.max(1, Math.round(perCompetency * mix.hard));
    const medium = Math.max(1, perCompetency - easy - hard);
    return { name: c.name, easy, medium, hard };
  });
}

module.exports = {
  _internal: {
    calculatePoolAllocation,
    FLOOR_QUESTIONS_PER_COMPETENCY,
    DIFFICULTY_MIX,
  },
};
