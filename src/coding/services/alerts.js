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

  // Tier 1: stderr log (ALWAYS — this is the on-server fallback so the
  // record exists in pm2 logs even if email/webhook fail).
  // eslint-disable-next-line no-console
  console.warn(`[alerts/${severity}] ${category}: ${title}${detail ? `\n${detail}` : ''}${
    fields ? `\n${Object.entries(fields).map(([k, v]) => `  ${k}: ${v}`).join('\n')}` : ''
  }`);

  // Tier 2: email (when ALERT_EMAIL_TO is set — primary channel for prod).
  const emailTo = process.env.ALERT_EMAIL_TO;
  if (emailTo) {
    void sendAlertEmail({ to: emailTo, category, title, detail, severity, fields }).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[alerts] email failed for ${category}:`, err.message);
    });
  }

  // Tier 3: webhook (Slack / Discord — optional).
  const url = process.env.ALERT_WEBHOOK_URL;
  if (url) {
    const payload = buildSlackPayload({ category, title, detail, severity, fields });
    try {
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
}

/**
 * Email alert via the existing SMTP transport. Lazy-requires nodemailer so
 * test environments without SMTP creds don't crash on import.
 */
async function sendAlertEmail({ to, category, title, detail, severity, fields }) {
  const nodemailer = require('nodemailer');
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
    throw new Error('SMTP not configured');
  }
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  const color = severity === 'error' ? '#c0392b'
              : severity === 'info'  ? '#3498db'
              : '#f39c12';
  const env = process.env.NODE_ENV || 'unknown';

  const fieldsHtml = fields
    ? `<table style="width:100%;border-collapse:collapse;margin-top:12px;font-size:13px">${
        Object.entries(fields).slice(0, 12).map(([k, v]) => `
          <tr>
            <td style="padding:4px 8px;background:#f4f4f8;font-weight:600;width:30%;border:1px solid #e5e7eb">${escapeHtml(k)}</td>
            <td style="padding:4px 8px;border:1px solid #e5e7eb"><code>${escapeHtml(String(v))}</code></td>
          </tr>`).join('')
      }</table>`
    : '';
  const detailHtml = detail
    ? `<div style="margin-top:12px;padding:12px;background:#f4f4f8;border-radius:6px;white-space:pre-wrap;font-family:Menlo,Consolas,monospace;font-size:12px">${escapeHtml(detail)}</div>`
    : '';

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px">
      <div style="background:${color};color:#fff;padding:12px 16px;border-radius:6px 6px 0 0;font-weight:700">
        ${severity.toUpperCase()} — ScaleUp Coding Alert
      </div>
      <div style="border:1px solid #e5e7eb;border-top:0;padding:16px;border-radius:0 0 6px 6px;background:#fff">
        <div style="font-size:16px;font-weight:600;color:#111827">${escapeHtml(title)}</div>
        ${detailHtml}
        ${fieldsHtml}
        <div style="margin-top:16px;padding-top:12px;border-top:1px solid #e5e7eb;font-size:11px;color:#6b7280">
          category: <code>${escapeHtml(category)}</code> · env: <code>${escapeHtml(env)}</code> · ${new Date().toISOString()}
        </div>
      </div>
    </div>`;

  const recipients = String(to).split(',').map((s) => s.trim()).filter(Boolean);
  await transporter.sendMail({
    from: process.env.SMTP_FROM || 'ScaleUp Alerts <noreply@scaleup.app>',
    to: recipients,
    subject: `[ScaleUp ${severity.toUpperCase()}] ${title}`,
    text: `${title}\n\n${detail || ''}\n\nCategory: ${category}\nEnv: ${env}\n${
      fields ? Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n') : ''
    }`,
    html,
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
