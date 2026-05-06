/**
 * Adaptive Selector Service — picks the next question for a diagnostic attempt
 * based on running performance per competency. Stateless; the caller passes in
 * the running state and gets back a decision.
 */

function initialDifficultyForRating(selfRating, rng = Math.random) {
  switch (selfRating) {
    case 'novice':
    case 'unsure':
      return 'easy';
    case 'familiar':
      return rng() < 0.5 ? 'easy' : 'medium';
    case 'proficient':
      return 'medium';
    case 'expert':
      return rng() < 0.5 ? 'medium' : 'hard';
    default:
      return 'medium';
  }
}

function bandToScore(band) {
  switch (band) {
    case 'novice': return 25;
    case 'familiar': return 50;
    case 'proficient': return 70;
    case 'expert': return 88;
    default: return 0;
  }
}

/**
 * Given a competency's running performance, pick the proficiency band.
 * Rules (simple, defensible):
 *   - If they got >=2 correct at hard → expert
 *   - Else if they got >=2 correct at medium → proficient
 *   - Else if they got >=2 correct at easy → familiar
 *   - Else → novice
 */
function deriveBand(perf) {
  const { easy, medium, hard } = perf;
  if ((hard?.correct || 0) >= 2 && (hard.correct - hard.wrong) >= 1) return 'expert';
  if ((medium?.correct || 0) >= 2 && (medium.correct - medium.wrong) >= 0) return 'proficient';
  if ((easy?.correct || 0) >= 2) return 'familiar';
  return 'novice';
}

const MAX_QUESTIONS_PER_COMPETENCY = 3;
const DIFFICULTY_LADDER = ['easy', 'medium', 'hard'];

function _bumpDifficulty(current, direction) {
  const i = DIFFICULTY_LADDER.indexOf(current);
  const next = i + (direction === 'up' ? 1 : -1);
  return DIFFICULTY_LADDER[Math.max(0, Math.min(DIFFICULTY_LADDER.length - 1, next))];
}

/**
 * Decide whether to stop and (if not) what difficulty the next question
 * should be. Caller drives the whole loop; this function is stateless.
 *
 * Inputs:
 *   perf: { easy: {correct, wrong}, medium: {...}, hard: {...} }
 *   questionsAsked: number of questions asked for this competency so far
 *   selfRating: 'novice' | 'familiar' | 'proficient' | 'expert' | 'unsure'
 *   currentDifficulty: difficulty of the most recent question
 *   lastAnswer: { correct: boolean, fast: boolean } (optional — null on first call)
 *
 * Returns: { shouldStop: boolean, nextDifficulty: string | null }
 */
function selectNext({ perf, questionsAsked, selfRating, currentDifficulty, lastAnswer, rng = Math.random }) {
  // Stop after 3 questions regardless of performance
  if (questionsAsked >= MAX_QUESTIONS_PER_COMPETENCY) {
    return { shouldStop: true, nextDifficulty: null };
  }

  // Stop early if signal converged: 2+ correct or 2+ wrong at same level
  for (const diff of DIFFICULTY_LADDER) {
    const p = perf[diff] || { correct: 0, wrong: 0 };
    if (p.correct >= 2 || p.wrong >= 2) {
      return { shouldStop: true, nextDifficulty: null };
    }
  }

  // First question for this competency
  if (questionsAsked === 0 || !lastAnswer) {
    return { shouldStop: false, nextDifficulty: initialDifficultyForRating(selfRating, rng) };
  }

  // Subsequent: adjust based on last answer
  if (lastAnswer.correct && lastAnswer.fast) {
    return { shouldStop: false, nextDifficulty: _bumpDifficulty(currentDifficulty, 'up') };
  }
  if (lastAnswer.correct && !lastAnswer.fast) {
    return { shouldStop: false, nextDifficulty: currentDifficulty };
  }
  // Wrong
  return { shouldStop: false, nextDifficulty: _bumpDifficulty(currentDifficulty, 'down') };
}

// ---------------------------------------------------------------------------
// Path C question selection (Plan 3a) — per-topic question planning based on
// the user's self-rating. Coexists with the v1 adaptive selector above; the
// orchestrator (diagnosticService) will switch to these helpers in Task 8.
// ---------------------------------------------------------------------------

const PLAN_BY_RATING = {
  novice: [
    { difficulty: 'easy', requiresScenario: false },
    { difficulty: 'easy', requiresScenario: false },
  ],
  familiar: [
    { difficulty: 'easy', requiresScenario: false },
    { difficulty: 'medium', requiresScenario: false },
    { difficulty: 'hard', requiresScenario: false },
  ],
  proficient: [
    { difficulty: 'medium', requiresScenario: false },
    { difficulty: 'hard', requiresScenario: false },
    { difficulty: 'hard', requiresScenario: false },
  ],
  expert: [
    { difficulty: 'hard', requiresScenario: false },
    { difficulty: 'hard', requiresScenario: true },
    { difficulty: 'hard', requiresScenario: true },
  ],
};

function questionPlanForTopic(canonicalTopic, rating) {
  const tmpl = PLAN_BY_RATING[rating];
  if (!tmpl) throw new Error(`Unknown rating: ${rating}`);
  return tmpl.map(p => ({ canonicalTopic, ...p }));
}

function totalQuestionsForAttempt(ratingsMap) {
  let total = 0;
  const iter = ratingsMap instanceof Map
    ? ratingsMap.values()
    : Object.values(ratingsMap || {});
  for (const rating of iter) {
    total += (PLAN_BY_RATING[rating] || []).length;
  }
  return total;
}

function bumpDifficultyBand(d) {
  if (d === 'easy') return 'medium';
  if (d === 'medium') return 'hard';
  return d;
}

function applyCompanyWeights(plan, weights) {
  if (!plan || plan.length === 0) return plan;
  if (!weights || (!(weights instanceof Map) && typeof weights !== 'object')) return plan;
  const get = (key) => weights instanceof Map ? weights.get(key) : weights[key];
  const weight = get(plan[0]?.canonicalTopic);
  if (weight == null) return plan;
  if (weight >= 1.5) {
    // Bump self-rated band by one — represented by upgrading easy→medium, medium→hard
    return plan.map(p => ({ ...p, difficulty: bumpDifficultyBand(p.difficulty) }));
  }
  if (weight <= 0.5) {
    // Drop one question (minimum 1)
    if (plan.length > 1) return plan.slice(0, -1);
  }
  return plan;
}

module.exports = {
  selectNext,
  questionPlanForTopic,
  totalQuestionsForAttempt,
  applyCompanyWeights,
  PLAN_BY_RATING,
  _internal: {
    initialDifficultyForRating,
    bandToScore,
    deriveBand,
    MAX_QUESTIONS_PER_COMPETENCY,
    DIFFICULTY_LADDER,
  },
};

// ---------------------------------------------------------------------------
// Per-objective-type variations (Plan 3a Task 2)
// ---------------------------------------------------------------------------

const VOICE_ELIGIBLE_KEYWORDS = {
  interview_preparation: ['behavioral', 'storytelling', 'situational', 'leadership-stories'],
  upskilling: ['stakeholder', 'leadership', 'cross-functional', 'communication', 'negotiation'],
  career_switch: ['stakeholder', 'leadership', 'transition-storytelling'],
};

function voiceEligibleTopics(objectiveType, canonicalTopics) {
  const keywords = VOICE_ELIGIBLE_KEYWORDS[objectiveType] || [];
  return canonicalTopics.filter((t) => keywords.some((k) => t.includes(k)));
}

function isStrictTimerObjective(objectiveType) {
  return objectiveType === 'exam_preparation';
}

module.exports.voiceEligibleTopics = voiceEligibleTopics;
module.exports.isStrictTimerObjective = isStrictTimerObjective;
