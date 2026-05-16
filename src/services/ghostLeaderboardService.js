const cohortDirectoryService = require('./cohortDirectoryService');

const GHOST_THRESHOLD = 10;

/**
 * Compose a final leaderboard list by merging real entries with ghosts
 * when the cohort is small. Never persists.
 *
 * @param {{ cohort: object, realEntries: Array<{userId, handicappedScore}>, weekStart: Date }} args
 * @returns {Array<{userId, handicappedScore, ghostKind, displayName?}>}
 */
function compose({ cohort, realEntries, weekStart }) {
  const reals = (realEntries || []).map(e => ({ ...e, ghostKind: e.ghostKind || null }));
  if (reals.length >= GHOST_THRESHOLD) {
    return reals.sort((a, b) => b.handicappedScore - a.handicappedScore);
  }

  const ghosts = [];

  // Historical anchors — drop silently if we have no stats yet.
  const stats = cohort.historicalStats || {};
  if (stats.sampleSize && stats.last30dP90Score != null) {
    ghosts.push({
      userId: `ghost-historical-p90-${cohort.canonicalTopic}`,
      displayName: 'Cohort top 10% (last month)',
      handicappedScore: stats.last30dP90Score,
      ghostKind: 'historical',
    });
  }
  if (stats.sampleSize && stats.last30dAverageScore != null) {
    ghosts.push({
      userId: `ghost-historical-avg-${cohort.canonicalTopic}`,
      displayName: 'Cohort average (last month)',
      handicappedScore: stats.last30dAverageScore,
      ghostKind: 'historical',
    });
  }

  // Persona ghosts — score derived from the cohort's running median (use
  // historical average as a stand-in when no per-week real signal exists).
  const median = stats.last30dAverageScore || 50;
  for (const persona of cohort.personaGhosts || []) {
    ghosts.push({
      userId: `ghost-persona-${cohort.canonicalTopic}-${persona.seed}`,
      displayName: persona.name,
      handicappedScore: cohortDirectoryService._internal.personaScoreForWeek(persona, weekStart, median),
      ghostKind: 'persona',
    });
  }

  // Merge + sort desc.
  let combined = [...reals, ...ghosts].sort((a, b) => b.handicappedScore - a.handicappedScore);

  // #1 honesty rule: if a ghost outranks the top real and reals exist,
  // promote the top real to position 0, boosting its displayed score to match
  // the top ghost so the descending-sort invariant is preserved.
  if (reals.length > 0 && combined[0].ghostKind != null) {
    const topGhostScore = combined[0].handicappedScore;
    const topRealIdx = combined.findIndex(e => e.ghostKind == null);
    if (topRealIdx > 0) {
      const [topReal] = combined.splice(topRealIdx, 1);
      combined.sort((a, b) => b.handicappedScore - a.handicappedScore);
      combined.unshift({ ...topReal, handicappedScore: Math.max(topReal.handicappedScore, topGhostScore) });
    }
  }

  return combined;
}

module.exports = { compose };
