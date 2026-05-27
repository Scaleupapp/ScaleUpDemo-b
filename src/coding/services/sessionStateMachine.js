'use strict';

const CapstoneSession = require('../models/capstoneSession.model');

/**
 * Capstone session state machine — single source of truth for which
 * transitions are legal and which timestamps to stamp on each transition.
 *
 * Centralising this prevents the bug where two controllers
 * (a route handler and a worker, say) both try to flip `submitted` and end
 * up doing it twice with inconsistent timestamps.
 *
 * The transition map below matches spec §7.2 exactly. Editing it is a
 * breaking change to mobile, so it has a coverage assertion in the
 * contract test.
 */

/**
 * Allowed forward edges. `null` value means terminal — no edges out.
 *
 * @type {Record<string, string[]|null>}
 */
const ALLOWED = {
  scheduled: ['provisioning', 'aborted', 'expired'],
  provisioning: ['ready', 'aborted'],
  ready: ['in_progress', 'aborted', 'expired'],
  in_progress: ['paused', 'submitted', 'aborted', 'expired'],
  paused: ['in_progress', 'submitted', 'aborted', 'expired'],
  submitted: ['evaluating'],
  evaluating: ['graded'],
  expired: ['submitted'], // auto-submit on hard timeout
  // terminal
  graded: null,
  aborted: null,
};

/**
 * Timestamps stamped when the session ENTERS each state. Most are obvious;
 * `paused_total_seconds` is computed on resume from `paused_at`.
 *
 * @type {Record<string, (session: import('mongoose').Document, now: Date) => Record<string, any>>}
 */
const ENTER_PATCHES = {
  scheduled: () => ({}),
  provisioning: () => ({}),
  ready: () => ({}),
  in_progress: (session, now) => {
    const patch = {};
    // First time entering in_progress = the timer starts. Subsequent entries
    // are resumes from `paused`; in that case, accumulate the paused duration.
    if (!session.started_at) patch.started_at = now;
    if (session.paused_at) {
      const pausedSec = Math.max(0, Math.floor((now.getTime() - session.paused_at.getTime()) / 1000));
      patch.paused_total_seconds = (session.paused_total_seconds || 0) + pausedSec;
      patch.paused_at = null;
    }
    return patch;
  },
  paused: (_, now) => ({ paused_at: now }),
  submitted: (_, now) => ({ submitted_at: now }),
  evaluating: (_, now) => ({ evaluating_started_at: now }),
  graded: (_, now) => ({ graded_at: now }),
  expired: () => ({}),
  aborted: () => ({}),
};

class InvalidTransitionError extends Error {
  constructor(from, to) {
    super(`Invalid capstone session transition: ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

/**
 * Returns true iff `from → to` is a legal transition.
 *
 * @param {string} from
 * @param {string} to
 */
function isAllowed(from, to) {
  const edges = ALLOWED[from];
  return Array.isArray(edges) && edges.includes(to);
}

/**
 * Apply a transition to a CapstoneSession document and persist. Throws
 * InvalidTransitionError if the edge isn't legal — callers should map this
 * to HTTP 409 with the OpenAPI `invalid_transition` error code.
 *
 * Concurrent transitions are guarded by an explicit findOneAndUpdate that
 * filters on the current `status`; if another writer beat us to the
 * update, we throw the same error.
 *
 * @param {import('mongoose').Types.ObjectId|string} sessionId
 * @param {string} to — target status
 * @param {object} [extra] — additional fields to set (e.g. sandbox_id when entering ready)
 * @returns {Promise<import('mongoose').Document>} — the updated session
 */
async function transition(sessionId, to, extra = {}) {
  const session = await CapstoneSession.findById(sessionId);
  if (!session) throw new Error(`CapstoneSession ${sessionId} not found`);

  const from = session.status;
  if (!isAllowed(from, to)) {
    throw new InvalidTransitionError(from, to);
  }

  const now = new Date();
  const enterPatch = ENTER_PATCHES[to] ? ENTER_PATCHES[to](session, now) : {};
  const update = { ...extra, ...enterPatch, status: to };

  // Optimistic concurrency: only update if status is still `from`.
  const updated = await CapstoneSession.findOneAndUpdate(
    { _id: sessionId, status: from },
    { $set: update },
    { new: true }
  );
  if (!updated) {
    // Lost the race — reload to see what actually happened, surface as an
    // invalid transition so caller can re-render with current status.
    const fresh = await CapstoneSession.findById(sessionId).lean();
    throw new InvalidTransitionError(fresh ? fresh.status : 'unknown', to);
  }
  return updated;
}

module.exports = {
  ALLOWED,
  ENTER_PATCHES,
  isAllowed,
  transition,
  InvalidTransitionError,
};
