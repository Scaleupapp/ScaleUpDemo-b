'use strict';

const s3 = require('../../../config/s3');

/**
 * Compass-log analyser — feeds the AI-pair-effectiveness dimension
 * (spec §8.2 row 3). Pulls `compass_turn` events from the recording
 * stream + derives:
 *   - turn count
 *   - accept / edit / reject ratios
 *   - rework cycles (consecutive rejected turns)
 *   - paste-event count (anti-cheat signal)
 *   - tab-blur count (focus-loss signal)
 *
 * The numbers feed the Sonnet prompt directly so the model can weigh
 * them against bundle expectations.
 */

const MAX_EVENTS = 10_000; // hard cap so a runaway stream doesn't OOM the worker

/**
 * @param {string} eventStreamS3Key
 * @returns {Promise<{
 *   turn_count: number,
 *   accept_count: number,
 *   edit_count: number,
 *   reject_count: number,
 *   rework_cycles: number,
 *   paste_count: number,
 *   tab_blur_count: number,
 *   accept_ratio: number,
 *   edit_ratio: number,
 *   reject_ratio: number,
 *   turns: Array<{ t: string, resolution: string, prompt_id?: string, summary?: string }>
 * }>}
 */
async function analyse(eventStreamS3Key) {
  if (!eventStreamS3Key) return zero();
  let buf;
  try {
    buf = await s3.downloadBuffer(eventStreamS3Key);
  } catch {
    return zero();
  }
  if (!buf || buf.length === 0) return zero();

  const lines = buf.toString('utf8').split('\n').filter(Boolean);
  if (lines.length > MAX_EVENTS) lines.length = MAX_EVENTS;

  const turns = [];
  let paste = 0;
  let tabBlur = 0;

  for (const line of lines) {
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (evt.type === 'compass_turn') {
      turns.push({
        t: evt.t,
        resolution: evt.payload?.resolution || 'unknown',
        prompt_id: evt.payload?.promptId || evt.payload?.prompt_id,
        summary: evt.payload?.summary,
      });
    } else if (evt.type === 'paste') {
      paste += 1;
    } else if (evt.type === 'tab_blur') {
      tabBlur += 1;
    }
  }

  const accept = turns.filter((t) => t.resolution === 'accept').length;
  const edit = turns.filter((t) => t.resolution === 'edit').length;
  const reject = turns.filter((t) => t.resolution === 'reject').length;
  const total = turns.length;

  // Rework cycles = runs of ≥2 consecutive rejects. Captures "the learner
  // kept getting bad suggestions and didn't recover" — a signal worth more
  // than raw reject count.
  let cycles = 0;
  let run = 0;
  for (const t of turns) {
    if (t.resolution === 'reject') {
      run += 1;
      if (run === 2) cycles += 1; // count each cycle once at the second consecutive reject
    } else {
      run = 0;
    }
  }

  return {
    turn_count: total,
    accept_count: accept,
    edit_count: edit,
    reject_count: reject,
    rework_cycles: cycles,
    paste_count: paste,
    tab_blur_count: tabBlur,
    accept_ratio: total === 0 ? 0 : round3(accept / total),
    edit_ratio: total === 0 ? 0 : round3(edit / total),
    reject_ratio: total === 0 ? 0 : round3(reject / total),
    turns,
  };
}

function zero() {
  return {
    turn_count: 0,
    accept_count: 0,
    edit_count: 0,
    reject_count: 0,
    rework_cycles: 0,
    paste_count: 0,
    tab_blur_count: 0,
    accept_ratio: 0,
    edit_ratio: 0,
    reject_ratio: 0,
    turns: [],
  };
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

module.exports = { analyse };
