'use strict';

/**
 * The "Go prove it" action is objective-aware — an interview is not the
 * universal end goal. `route` is a client-side intent string the apps map to an
 * existing surface. `comingSoonProof` always true: the verifiable proof card
 * (Phase 3B) is teased for every archetype as the universal layer.
 */
const MAP = {
  interview_preparation: { kind: 'interview', label: 'Ace a real interview', route: 'interview' },
  career_switch:         { kind: 'interview', label: 'Ace a real interview', route: 'interview' },
  exam_preparation:      { kind: 'exam',      label: 'Final readiness check', route: 'exam_ready' },
  upskilling:            { kind: 'apply',     label: 'Put it to work',        route: 'capstone' },
  academic_excellence:   { kind: 'apply',     label: 'Put it to work',        route: 'capstone' },
};
const DEFAULT = { kind: 'proof', label: 'Get your proof', route: 'proof' };

function proveItFor(objectiveType) {
  const base = MAP[objectiveType] || DEFAULT;
  return { ...base, comingSoonProof: true };
}

module.exports = { proveItFor };
