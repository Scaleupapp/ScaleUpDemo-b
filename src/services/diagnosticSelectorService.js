/**
 * Adaptive Selector Service — picks the next question for a diagnostic attempt
 * based on running performance per competency. Stateless; the caller passes in
 * the running state and gets back a decision.
 */

function initialDifficultyForRating(selfRating) {
  switch (selfRating) {
    case 'novice':
    case 'unsure':
      return 'easy';
    case 'familiar':
      return Math.random() < 0.5 ? 'easy' : 'medium';
    case 'proficient':
      return 'medium';
    case 'expert':
      return Math.random() < 0.5 ? 'medium' : 'hard';
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

module.exports = {
  _internal: {
    initialDifficultyForRating,
    bandToScore,
    deriveBand,
  },
};
