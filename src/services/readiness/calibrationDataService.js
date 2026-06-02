'use strict';
const ObjectiveOutcome = require('../../models/ObjectiveOutcome');
const { setKeyFor } = require('./outcomeService');

const Y = { SUCCESS: 1, PARTIAL: 0.5, NOT_SUCCESS: 0 };

/** Resolved, terminal-label outcomes with a usable readiness feature → training rows.
 *  PENDING/ABANDONED excluded (unresolved / dropped, not measurable outcomes). */
async function assembleRows() {
  const docs = await ObjectiveOutcome
    .find({ label: { $in: ['SUCCESS', 'PARTIAL', 'NOT_SUCCESS'] } })
    .lean();
  const rows = [];
  for (const d of docs) {
    if (!(d.label in Y)) continue; // skip PENDING / ABANDONED / unknown
    const c = d.context || {};
    const readiness = [c.readinessAtTarget, c.peakReadiness, c.readinessAtCapture].find((v) => typeof v === 'number');
    if (readiness == null) continue;
    rows.push({
      archetype: setKeyFor(d.objectiveType),
      readiness,
      y: Y[d.label],
      features: { wasEverReady: !!c.wasEverReady, coverage: c.coverageAtCapture ?? null, weeksToOutcome: c.weeksToOutcome ?? null },
    });
  }
  return rows;
}

async function countsByArchetype() {
  const rows = await assembleRows();
  return rows.reduce((m, r) => { m[r.archetype] = (m[r.archetype] || 0) + 1; return m; }, {});
}

module.exports = { assembleRows, countsByArchetype };
