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
 * Requires 3 env vars on the host:
 *   MIXPANEL_PROJECT_ID
 *   MIXPANEL_SERVICE_ACCOUNT_USERNAME
 *   MIXPANEL_SERVICE_ACCOUNT_PASSWORD
 * Missing creds → soft-degrade to zeros (cron never crashes).
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
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Mixpanel Export API fetch
// ---------------------------------------------------------------------------

async function fetchMetricsViaExport() {
  const projectId = process.env.MIXPANEL_PROJECT_ID;
  const serviceUser = process.env.MIXPANEL_SERVICE_ACCOUNT_USERNAME;
  const servicePass = process.env.MIXPANEL_SERVICE_ACCOUNT_PASSWORD;
  const auth = 'Basic ' + Buffer.from(`${serviceUser}:${servicePass}`).toString('base64');

  const yesterdayDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const fromDate = yesterdayDate.toISOString().split('T')[0];
  const toDate = fromDate;
  const date = fromDate;

  async function fetchEvent(eventName) {
    const url = `https://data-eu.mixpanel.com/api/2.0/export?project_id=${projectId}&from_date=${fromDate}&to_date=${toDate}&event=["${eventName}"]`;
    const res = await globalThis.fetch(url, { headers: { Authorization: auth } });
    if (!res.ok) {
      console.warn(`[mixpanelDailyDigestWorker] ${eventName} fetch failed: ${res.status}`);
      return [];
    }
    const text = await res.text();
    return text.trim().split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  }

  const [startedEvents, completedEvents, planCompletedEvents, missEvents] = await Promise.all([
    fetchEvent('diagnostic_started'),
    fetchEvent('diagnostic_completed'),
    fetchEvent('plan_generation_completed'),
    fetchEvent('topic_taxonomy_lookup_miss'),
  ]);

  const diagnosticStarted = startedEvents.length;
  const diagnosticCompleted = completedEvents.length;
  const completionRate = diagnosticStarted > 0
    ? Math.round((diagnosticCompleted / diagnosticStarted) * 1000) / 10
    : 0;

  const latencies = planCompletedEvents
    .map(e => e?.properties?.latencyMs)
    .filter(n => typeof n === 'number')
    .sort((a, b) => a - b);
  const planGenerationP50ms = latencies.length > 0
    ? latencies[Math.floor(latencies.length / 2)]
    : 0;

  const missCounts = new Map();
  for (const e of missEvents) {
    const key = e?.properties?.canonicalTarget;
    if (!key) continue;
    missCounts.set(key, (missCounts.get(key) || 0) + 1);
  }
  const topMisses = [...missCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([canonicalTarget, hits]) => ({ canonicalTarget, hits }));

  return { date, diagnosticStarted, diagnosticCompleted, completionRate, planGenerationP50ms, topMisses };
}

async function fetchMetrics() {
  if (!process.env.MIXPANEL_PROJECT_ID || !process.env.MIXPANEL_SERVICE_ACCOUNT_USERNAME) {
    console.warn('[mixpanelDailyDigestWorker] Mixpanel creds missing — returning zeros');
    return {
      date: yesterday(),
      diagnosticStarted: 0,
      diagnosticCompleted: 0,
      completionRate: 0,
      planGenerationP50ms: 0,
      topMisses: [],
    };
  }
  try {
    return await fetchMetricsViaExport();
  } catch (err) {
    console.error('[mixpanelDailyDigestWorker] fetchMetrics failed, returning zeros:', err.message);
    return {
      date: yesterday(),
      diagnosticStarted: 0,
      diagnosticCompleted: 0,
      completionRate: 0,
      planGenerationP50ms: 0,
      topMisses: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

async function run() {
  const rawMetrics = await fetchMetrics();
  const date = rawMetrics.date || yesterday();

  // Map to buildDigestBody's expected shape
  const digestMetrics = {
    started: rawMetrics.diagnosticStarted,
    completed: rawMetrics.diagnosticCompleted,
    completionRate: rawMetrics.completionRate,
    p50LatencyMs: rawMetrics.planGenerationP50ms,
    topMisses: (rawMetrics.topMisses || []).map(m =>
      typeof m === 'object' ? `${m.canonicalTarget} (${m.hits})` : m
    ),
  };

  const body = buildDigestBody(digestMetrics, date);
  await emailService.sendDailyDigest(DIGEST_TO, body);
  console.log(`[mixpanelDailyDigestWorker] Digest for ${date} sent to ${DIGEST_TO}.`);
  return { date, ...rawMetrics };
}

module.exports = { run, buildDigestBody, fetchMetrics };
