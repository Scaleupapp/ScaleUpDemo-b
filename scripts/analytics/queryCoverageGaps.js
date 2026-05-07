#!/usr/bin/env node
/**
 * queryCoverageGaps — queries Mixpanel for the last 30 days of
 * topic_taxonomy_lookup_miss and question_bank_lookup_miss events,
 * ranks the top 30 by hit count, and writes a markdown report to
 * docs/superpowers/research/{date}-coverage-gaps.md.
 *
 * Run monthly post-launch. Output feeds the gap-fill batch (Task 6).
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const MIXPANEL_TOKEN = process.env.MIXPANEL_TOKEN;
const MIXPANEL_SECRET = process.env.MIXPANEL_SECRET;
const MIXPANEL_API = 'https://data.mixpanel.com/api/2.0/export';

const MISS_EVENTS = ['topic_taxonomy_lookup_miss', 'question_bank_lookup_miss'];
const TOP_N = 30;
const DAYS_BACK = 30;

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function dateRange() {
  const to = new Date();
  const from = new Date(Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000);
  return { from: isoDate(from), to: isoDate(to) };
}

/**
 * rankGaps — pure function that aggregates raw event lines into a ranked list.
 * Accepts an array of parsed event objects (each with properties.target_key).
 * Returns top-N entries sorted by hitCount descending.
 */
function rankGaps(events, topN = TOP_N) {
  const counts = {};
  for (const ev of events) {
    const key = (ev.properties && ev.properties.target_key) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([targetKey, hitCount]) => ({ targetKey, hitCount }))
    .sort((a, b) => b.hitCount - a.hitCount)
    .slice(0, topN);
}

async function fetchMixpanelEvents(from, to) {
  if (!MIXPANEL_TOKEN || !MIXPANEL_SECRET) {
    throw new Error('MIXPANEL_TOKEN and MIXPANEL_SECRET env vars are required');
  }

  const params = new URLSearchParams({
    from_date: from,
    to_date: to,
    event: JSON.stringify(MISS_EVENTS),
  });

  const url = `${MIXPANEL_API}?${params.toString()}`;
  const credentials = Buffer.from(`${MIXPANEL_SECRET}:`).toString('base64');

  const res = await globalThis.fetch(url, {
    headers: {
      Authorization: `Basic ${credentials}`,
      Accept: 'text/plain',
    },
  });

  if (!res.ok) {
    throw new Error(`Mixpanel API error: ${res.status} ${res.statusText}`);
  }

  const text = await res.text();
  const events = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }
  return events;
}

function buildReport(gaps, from, to) {
  const date = isoDate(new Date());
  const rows = gaps
    .map((g, i) => `| ${i + 1} | \`${g.targetKey}\` | ${g.hitCount} |`)
    .join('\n');

  return `# Coverage Gaps — ${date}

Query window: ${from} → ${to} (last ${DAYS_BACK} days)
Events: \`topic_taxonomy_lookup_miss\`, \`question_bank_lookup_miss\`

## Top ${TOP_N} Missing Targets

| Rank | targetKey | Hits |
|------|-----------|------|
${rows}

## Next Steps

1. Feed the top targets into \`scripts/seed/runGapFillBatch.js\`
2. Prioritise entries with hitCount ≥ 5 (strong demand signal)
3. Manually verify targetKey format before running gap-fill
`;
}

async function main() {
  const { from, to } = dateRange();
  console.log(`Querying Mixpanel for miss events from ${from} to ${to}...`);

  const events = await fetchMixpanelEvents(from, to);
  console.log(`Fetched ${events.length} raw events.`);

  const gaps = rankGaps(events);
  console.log(`Top ${gaps.length} coverage gaps:`);
  for (const g of gaps) {
    console.log(`  ${g.hitCount.toString().padStart(4)} hits  ${g.targetKey}`);
  }

  const date = isoDate(new Date());
  const outDir = path.join(__dirname, '../../docs/superpowers/research');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${date}-coverage-gaps.md`);
  fs.writeFileSync(outPath, buildReport(gaps, from, to), 'utf8');
  console.log(`\nReport written to ${outPath}`);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { rankGaps, buildReport };
