'use strict';

/**
 * mixpanelDailyDigestWorker — emails yesterday's diagnostic KPIs at 09:00 IST.
 *
 * Cron: '30 3 * * *'  (03:30 UTC = 09:00 IST)
 *
 * Metrics emailed:
 *   - diagnostic_started count (yesterday)
 *   - diagnostic_completed count (yesterday)
 *   - completion rate (%)
 *   - p50 plan generation latency (ms)
 *   - top 3 coverage-miss canonicalTargets
 *
 * fetchMetrics is a stub — real Mixpanel JQL queries are post-launch work
 * once production traffic exists. Wire to real queries once the launch
 * dashboard is flowing.
 */

const emailService = require('../services/emailService');

const DIGEST_TO = 'nirpeksh@scaleupapp.club';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function yesterday() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return isoDate(d);
}

/**
 * buildDigestBody — formats metrics into a plain-text email body.
 * Pure function; exported for testing.
 */
function buildDigestBody(metrics, date) {
  const { started, completed, completionRate, p50LatencyMs, topMisses } = metrics;
  const missLines = (topMisses || []).map((m, i) => `  ${i + 1}. ${m}`).join('\n');

  return [
    `ScaleUp Daily Diagnostic Digest — ${date}`,
    '',
    `Diagnostic sessions started:   ${started}`,
    `Diagnostic sessions completed: ${completed}`,
    `Completion rate:               ${completionRate}%`,
    `p50 plan generation latency:   ${p50LatencyMs} ms`,
    '',
    'Top 3 coverage misses (canonicalTarget):',
    missLines || '  (none)',
    '',
    '---',
    'fetchMetrics is a stub — wire to real Mixpanel JQL queries post-launch.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Data fetch stub
// ---------------------------------------------------------------------------

/**
 * fetchMetrics — stub that returns zeroed metrics.
 * Replace with real Mixpanel JQL queries once production traffic exists.
 */
async function fetchMetrics(_date) {
  return {
    started: 0,
    completed: 0,
    completionRate: 0,
    p50LatencyMs: 0,
    topMisses: [],
  };
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

async function run() {
  const date = yesterday();
  const metrics = await fetchMetrics(date);
  const body = buildDigestBody(metrics, date);
  await emailService.sendDailyDigest(DIGEST_TO, body);
  console.log(`[mixpanelDailyDigestWorker] Digest for ${date} sent to ${DIGEST_TO}.`);
  return { date, ...metrics };
}

module.exports = { run, buildDigestBody };
