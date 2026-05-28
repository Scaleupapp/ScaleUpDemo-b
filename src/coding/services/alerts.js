'use strict';

/**
 * Operational alerts — single seam for all "something went wrong, look at
 * it" notifications from the coding workstream.
 *
 * Transport: an outbound webhook (Slack incoming-webhook compatible). Set
 * ALERT_WEBHOOK_URL in env. When unset, every alert is logged to stderr
 * at warn level and otherwise silently dropped — so local dev / tests
 * never have to mock the webhook.
 *
 * Categories the rest of the codebase fires:
 *   - `cost.session-over-budget`      — per-session LLM spend > threshold
 *   - `cost.daily-over-budget`        — global daily spend > threshold
 *   - `drift.anchor-exceeded`         — anchor-drift threshold tripped
 *   - `drift.rate-exceeded`           — drift_rate over 5% (spec §14.2)
 *   - `worker.job-exhausted`          — BullMQ job exhausted retries
 *   - `sandbox.egress-not-locked`     — provisioned sandbox missed lockdown
 *   - `evaluator.human-review-spike`  — HRQ pending count above ceiling
 *
 * Rate limiting: each (category, dedupKey) tuple fires at most once per
 * ALERT_DEDUP_WINDOW_MS (default 10 min) — prevents PagerDuty-style flapping
 * when a hot loop trips the same threshold every iteration.
 */

const DEFAULT_DEDUP_WINDOW_MS = 10 * 60 * 1000;
const RECENT = new Map(); // key: `${category}::${dedupKey}` → lastFiredAt ms

function withinDedupWindow(key, now) {
  const last = RECENT.get(key);
  const window = Number(process.env.ALERT_DEDUP_WINDOW_MS) || DEFAULT_DEDUP_WINDOW_MS;
  if (last && now - last < window) return true;
  RECENT.set(key, now);
  // Trim the map periodically to avoid unbounded growth in long-running
  // workers. Cap at ~1k entries (categories × distinct dedup keys).
  if (RECENT.size > 1024) {
    const cutoff = now - window;
    for (const [k, t] of RECENT) if (t < cutoff) RECENT.delete(k);
  }
  return false;
}

/**
 * Fire an alert. Never throws — webhook failures are logged but don't
 * propagate (alerts must not break the caller path).
 *
 * @param {object} args
 * @param {string} args.category      — taxonomy from the list above
 * @param {string} args.title         — single-line headline for Slack
 * @param {string} [args.detail]      — multi-line body (markdown ok)
 * @param {string} [args.dedupKey]    — coalesce identical alerts (default: category)
 * @param {'info'|'warn'|'error'} [args.severity='warn']
 * @param {Record<string, string|number>} [args.fields] — key/value rows surfaced in Slack
 */
async function fire({ category, title, detail, dedupKey, severity = 'warn', fields } = {}) {
  if (!category || !title) return;
  const now = Date.now();
  const key = `${category}::${dedupKey || category}`;
  if (withinDedupWindow(key, now)) return;

  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) {
    // No webhook configured — log and return. Dev / test path.
    // eslint-disable-next-line no-console
    console.warn(`[alerts/${severity}] ${category}: ${title}${detail ? `\n${detail}` : ''}`);
    return;
  }

  const payload = buildSlackPayload({ category, title, detail, severity, fields });
  try {
    // Node 18+ has global fetch.
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.error(`[alerts] webhook returned ${res.status} for ${category}`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[alerts] webhook POST failed for ${category}:`, err.message);
  }
}

function buildSlackPayload({ category, title, detail, severity, fields }) {
  const color = severity === 'error' ? '#c0392b'
              : severity === 'info'  ? '#3498db'
              : '#f39c12';
  const blocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*[${severity.toUpperCase()}] ${title}*` },
    },
  ];
  if (detail) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: detail },
    });
  }
  if (fields && Object.keys(fields).length > 0) {
    blocks.push({
      type: 'section',
      fields: Object.entries(fields).slice(0, 10).map(([k, v]) => ({
        type: 'mrkdwn',
        text: `*${k}:*\n${v}`,
      })),
    });
  }
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `category: \`${category}\` · env: \`${process.env.NODE_ENV || 'unknown'}\`` }],
  });
  return {
    text: `[${severity.toUpperCase()}] ${title}`, // fallback for clients that ignore blocks
    attachments: [{ color, blocks }],
  };
}

/** Test helper — clear the dedup memory between unit tests. */
function _resetDedup() {
  RECENT.clear();
}

module.exports = { fire, _resetDedup };
