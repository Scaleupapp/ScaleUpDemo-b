/**
 * Predicted-Impact-Per-Task Service (v2)
 *
 * Powers the "Why this matters today — after this, you'll be at ~36% on DP (up from 30%)" callout.
 *
 * Heuristic estimator (v0). Refined later with real outcome correlations:
 *   - Watching a 20-min video on weak topic X: +3 to +6 points on X mastery (capped by ceiling)
 *   - Taking a quiz on X: +2 to +5 points if score >= 70%
 *   - Mock interview: +1 to +3 points across multiple topics
 *   - Note creation on X: +2 to +4 points on X mastery
 *
 * Returns a per-task "expected delta" so the UI can render "you'll move from X% to Y%".
 */

const MASTERY_CEILING = 95;

// Per-task-type expected mastery gain.
// Tuned to be optimistic-but-honest. Refine quarterly with outcome data.
const TASK_IMPACT_BASE = {
  watch:           { gainMin: 3, gainMax: 6, scope: 'topic'   }, // primary topic only
  listen:          { gainMin: 2, gainMax: 4, scope: 'topic'   },
  read:            { gainMin: 2, gainMax: 5, scope: 'topic'   },
  quiz:            { gainMin: 2, gainMax: 5, scope: 'topic',   conditional: 'requires score >= 70%' },
  interview:       { gainMin: 1, gainMax: 3, scope: 'multi'   },
  mock_exam:       { gainMin: 4, gainMax: 8, scope: 'multi'   },
  notes_create:    { gainMin: 2, gainMax: 4, scope: 'topic'   },
  reflection:      { gainMin: 1, gainMax: 2, scope: 'multi'   },
  conversation:    { gainMin: 1, gainMax: 3, scope: 'topic'   },
  coding_practice: { gainMin: 3, gainMax: 6, scope: 'topic'   },
};

/**
 * Estimate expected mastery delta for a planned task.
 *
 * @param {Object} args
 * @param {String} args.taskType        - matches TASK_IMPACT_BASE keys
 * @param {String} args.primaryTopic    - e.g., "dp"
 * @param {Number} args.currentMastery  - 0-100 current mastery on primaryTopic
 * @param {Number} args.difficulty      - 1-5 (5 = hardest), affects gain ceiling
 *
 * @returns {Object}
 *   {
 *     expectedFrom:   Number,
 *     expectedTo:     Number,
 *     expectedGain:   Number,
 *     scope:          'topic' | 'multi',
 *     whyText:        String,
 *     conditional:    String | null
 *   }
 */
function predictTaskImpact({ taskType, primaryTopic, currentMastery = 0, difficulty = 3 }) {
  const base = TASK_IMPACT_BASE[taskType] || TASK_IMPACT_BASE.watch;

  // Difficulty scales gain (harder content → bigger gain when consumed)
  const diffFactor = 0.7 + (difficulty * 0.1);  // 0.8x .. 1.2x
  const headroom = Math.max(0, MASTERY_CEILING - currentMastery);

  const rawMin = base.gainMin * diffFactor;
  const rawMax = base.gainMax * diffFactor;
  // Mid-point as our point estimate
  const mid = (rawMin + rawMax) / 2;

  // Diminishing returns near ceiling
  const adjusted = Math.round(Math.min(mid, headroom * 0.6));

  const expectedFrom = Math.round(currentMastery);
  const expectedTo = Math.min(MASTERY_CEILING, expectedFrom + adjusted);

  let whyText;
  if (currentMastery < 40) {
    whyText = `This closes a major gap on ${primaryTopic}.`;
  } else if (currentMastery < 70) {
    whyText = `This consolidates your ${primaryTopic} mastery.`;
  } else {
    whyText = `Maintenance practice on ${primaryTopic} to keep retention high.`;
  }

  return {
    expectedFrom,
    expectedTo,
    expectedGain: adjusted,
    scope: base.scope,
    whyText,
    conditional: base.conditional || null,
  };
}

module.exports = {
  predictTaskImpact,
  _internal: { TASK_IMPACT_BASE, MASTERY_CEILING },
};
