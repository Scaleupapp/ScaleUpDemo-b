'use strict';

/**
 * sentinelService — the ops sentinel agent (#12).
 *
 * A fully deterministic (ZERO LLM calls) daily audit of the LLM estate that
 * closes the meta-loop where the ledger watches the agents. Four checks:
 *
 *   1. Zero-cost anomaly: LLMSpend rows in the last 24h with cost_usd === 0
 *      but nonzero tokens — the exact shape of a pricing-key bug (the
 *      Haiku $0-cost defect this agent exists to catch class-wide).
 *   2. Spend spike: per task_id, last-24h cost vs the trailing 30-day daily
 *      average, gated by BOTH a relative factor (env
 *      SENTINEL_SPEND_SPIKE_FACTOR, default 2x) AND an absolute $1 floor —
 *      the floor keeps a task going from $0.01/day to $0.03/day from
 *      generating noise.
 *   3. Model inventory: distinct `model` values seen in the last 24h.
 *      Informational only, never a finding — scanning against a hardcoded
 *      retirement list would rot the moment a new model ships; surfacing
 *      the inventory lets a human eyeball it for strays instead.
 *   4. Agent report card: AgentDecision rows over the last 7 days, grouped
 *      by agentId x status. acceptance = (accepted+adjusted)/responded,
 *      ignoredRate = ignored/responded (both denominatored on "responded" =
 *      total minus still-pending rows). Agents with >=10 responded rows AND
 *      (acceptance < 30% OR ignoredRate > 50%) get a finding. The card
 *      itself lists EVERY agent seen, not just the ones that triggered.
 *
 * Every check runs in its own try/catch — one check's failure (bad query,
 * transient DB hiccup) never kills the brief; it becomes a
 * `{ kind, error: true, message }` finding instead so the failure is visible
 * on the ledger and via alerts.fire like any other finding.
 *
 * Deliberately reads AND writes AgentDecision (its own report card reads the
 * same collection its `ops_sentinel` row writes to) — the sentinel's own
 * acceptance/ignore rate is never used to gate anything; it is data for a
 * human, same as every other agent's row.
 *
 * ONE ledger row is written per run, always — even at zero findings, because
 * the quiet-day row is the only proof the sentinel actually ran.
 *
 * All functions take an optional `deps` for test injection (repo convention:
 * zero network/DB in tests).
 */

const DEFAULT_SPEND_SPIKE_FACTOR = 2;
const SPEND_SPIKE_FLOOR_USD = 1;
const REPORT_CARD_MIN_RESPONDED = 10;
const PROMPT_VERSION = 'sentinel-v1';

const MS_24H = 24 * 60 * 60 * 1000;
const MS_7D = 7 * 24 * 60 * 60 * 1000;
const MS_30D = 30 * 24 * 60 * 60 * 1000;

function defaultDeps() {
  return {
    LLMSpend: require('../coding/models/llmSpend.model'),
    AgentDecision: require('../models/AgentDecision'),
    alerts: require('../coding/services/alerts'),
    isAgentEnabled: require('../config/agentFlags').isAgentEnabled,
    record: require('./agentDecisionService').record,
    now: () => new Date(),
  };
}

function round2(n) {
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) / 100 : n;
}

// ── Check 1: zero-cost anomaly ──────────────────────────────────────────────

async function checkZeroCost(since24h, d) {
  const rows = await d.LLMSpend.aggregate([
    {
      $match: {
        createdAt: { $gte: since24h },
        cost_usd: 0,
        $expr: { $gt: [{ $add: ['$tokens_in', '$tokens_out'] }, 0] },
      },
    },
    { $group: { _id: '$model', count: { $sum: 1 } } },
  ]);
  return (rows || [])
    .filter((r) => r && r._id)
    .map((r) => ({ kind: 'zero_cost', model: r._id, count: r.count }));
}

// ── Check 2: spend spike ─────────────────────────────────────────────────────

async function checkSpendSpike(since24h, since30d, d) {
  const factorThreshold = Number(process.env.SENTINEL_SPEND_SPIKE_FACTOR) || DEFAULT_SPEND_SPIKE_FACTOR;

  const [last24, last30] = await Promise.all([
    d.LLMSpend.aggregate([
      { $match: { createdAt: { $gte: since24h } } },
      { $group: { _id: '$task_id', cost: { $sum: '$cost_usd' } } },
    ]),
    d.LLMSpend.aggregate([
      { $match: { createdAt: { $gte: since30d } } },
      { $group: { _id: '$task_id', totalCost: { $sum: '$cost_usd' } } },
    ]),
  ]);

  const avgByTask = new Map((last30 || []).map((r) => [String(r._id), (r.totalCost || 0) / 30]));

  const findings = [];
  for (const r of last24 || []) {
    if (!r || !r._id) continue;
    const taskId = r._id;
    const cost24h = r.cost || 0;
    const avg = avgByTask.get(String(taskId)) || 0;
    const factor = avg > 0 ? cost24h / avg : (cost24h > 0 ? Infinity : 0);

    if (factor > factorThreshold && cost24h > SPEND_SPIKE_FLOOR_USD) {
      findings.push({
        kind: 'spend_spike',
        task_id: taskId,
        cost24h: round2(cost24h),
        dailyAvg30d: round2(avg),
        factor: Number.isFinite(factor) ? round2(factor) : null,
      });
    }
  }
  return findings;
}

// ── Check 3: model inventory (informational, never a finding) ──────────────

async function checkModelInventory(since24h, d) {
  const rows = await d.LLMSpend.aggregate([
    { $match: { createdAt: { $gte: since24h } } },
    { $group: { _id: '$model' } },
  ]);
  return (rows || []).map((r) => r && r._id).filter(Boolean).sort();
}

// ── Check 4: agent report card ──────────────────────────────────────────────

async function checkAgentReportCard(since7d, d) {
  const rows = await d.AgentDecision.aggregate([
    { $match: { createdAt: { $gte: since7d } } },
    { $group: { _id: { agentId: '$agentId', status: '$status' }, count: { $sum: 1 } } },
  ]);

  const byAgent = new Map();
  for (const r of rows || []) {
    const agentId = r && r._id && r._id.agentId;
    const status = r && r._id && r._id.status;
    if (!agentId || !status) continue;
    if (!byAgent.has(agentId)) byAgent.set(agentId, {});
    byAgent.get(agentId)[status] = (byAgent.get(agentId)[status] || 0) + (r.count || 0);
  }

  const reportCard = [];
  const findings = [];

  for (const [agentId, statuses] of byAgent) {
    const pending = statuses.pending || 0;
    const accepted = statuses.accepted || 0;
    const adjusted = statuses.adjusted || 0;
    const rejected = statuses.rejected || 0;
    const ignored = statuses.ignored || 0;
    const responded = accepted + adjusted + rejected + ignored;

    const acceptance = responded > 0 ? (accepted + adjusted) / responded : null;
    const ignoredRate = responded > 0 ? ignored / responded : null;

    const card = {
      agentId,
      responded,
      pendingBacklog: pending,
      acceptance: acceptance === null ? null : round2(acceptance),
      ignoredRate: ignoredRate === null ? null : round2(ignoredRate),
    };
    reportCard.push(card);

    if (
      responded >= REPORT_CARD_MIN_RESPONDED &&
      ((acceptance !== null && acceptance < 0.3) || (ignoredRate !== null && ignoredRate > 0.5))
    ) {
      findings.push({ kind: 'agent_report_card', ...card });
    }
  }

  return { reportCard, findings };
}

// ── Alert composition ────────────────────────────────────────────────────────

function alertForFinding(finding) {
  if (finding.error) {
    return {
      title: `Sentinel check failed: ${finding.kind}`,
      detail: finding.message,
      key: 'error',
      fields: { kind: finding.kind, message: finding.message },
    };
  }
  switch (finding.kind) {
    case 'zero_cost':
      return {
        title: `Zero-cost LLM spend: ${finding.model}`,
        detail: `${finding.count} row(s) for model "${finding.model}" had cost_usd=0 with nonzero tokens in the last 24h — likely a pricing-key bug (the Haiku-class defect this check exists to catch).`,
        key: finding.model,
        fields: { model: finding.model, count: finding.count },
      };
    case 'spend_spike':
      return {
        title: `Spend spike: task ${finding.task_id}`,
        detail: `Last-24h cost $${finding.cost24h} vs trailing 30-day daily average $${finding.dailyAvg30d}` +
          (finding.factor == null ? ' (no trailing baseline).' : ` — ${finding.factor}x.`),
        key: finding.task_id,
        fields: {
          task_id: finding.task_id,
          cost24h: finding.cost24h,
          dailyAvg30d: finding.dailyAvg30d,
          factor: finding.factor,
        },
      };
    case 'agent_report_card':
      return {
        title: `Agent report card: ${finding.agentId} underperforming`,
        detail: `Acceptance ${finding.acceptance == null ? 'n/a' : `${(finding.acceptance * 100).toFixed(0)}%`}, `
          + `ignored ${finding.ignoredRate == null ? 'n/a' : `${(finding.ignoredRate * 100).toFixed(0)}%`} `
          + `over ${finding.responded} responded rows (7d). Pending backlog: ${finding.pendingBacklog}.`,
        key: finding.agentId,
        fields: {
          agentId: finding.agentId,
          acceptance: finding.acceptance,
          ignoredRate: finding.ignoredRate,
          responded: finding.responded,
          pendingBacklog: finding.pendingBacklog,
        },
      };
    default:
      return { title: `Sentinel finding: ${finding.kind}`, detail: null, key: finding.kind, fields: finding };
  }
}

// ── runDaily ─────────────────────────────────────────────────────────────────

/**
 * runDaily(deps) -> Promise<{ findings: n }>
 *
 * Flag-gated (`ops_sentinel`, zero DB reads when off). Runs all four checks
 * (each isolated by its own try/catch), fires an alert per finding, and
 * ALWAYS records exactly one `ops_sentinel` AgentDecision ledger row — even
 * when findings is 0 — so the quiet-day row proves the sweep ran.
 */
async function runDaily(deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  if (!d.isAgentEnabled('ops_sentinel')) return { findings: 0 };

  const now = (d.now && d.now()) || new Date();
  const since24h = new Date(now.getTime() - MS_24H);
  const since30d = new Date(now.getTime() - MS_30D);
  const since7d = new Date(now.getTime() - MS_7D);

  const findings = [];
  let reportCard = [];
  let modelInventory = [];

  try {
    findings.push(...(await checkZeroCost(since24h, d)));
  } catch (err) {
    findings.push({ kind: 'zero_cost', error: true, message: err && err.message });
  }

  try {
    findings.push(...(await checkSpendSpike(since24h, since30d, d)));
  } catch (err) {
    findings.push({ kind: 'spend_spike', error: true, message: err && err.message });
  }

  try {
    modelInventory = await checkModelInventory(since24h, d);
  } catch (err) {
    findings.push({ kind: 'model_inventory', error: true, message: err && err.message });
  }

  try {
    const result = await checkAgentReportCard(since7d, d);
    reportCard = result.reportCard;
    findings.push(...result.findings);
  } catch (err) {
    findings.push({ kind: 'agent_report_card', error: true, message: err && err.message });
  }

  for (const finding of findings) {
    const { title, detail, key, fields } = alertForFinding(finding);
    await d.alerts.fire({
      category: 'agentic-sentinel',
      title,
      detail,
      dedupKey: `sentinel:${finding.kind}:${key}`,
      severity: 'warn',
      fields,
    });
  }

  await d.record({
    agentId: 'ops_sentinel',
    decisionType: 'brief',
    action: { kind: 'ops_brief', findings, reportCard, modelInventory },
    promptVersion: PROMPT_VERSION,
  }, d);

  return { findings: findings.length };
}

module.exports = {
  runDaily,
  _helpers: {
    PROMPT_VERSION,
    DEFAULT_SPEND_SPIKE_FACTOR,
    SPEND_SPIKE_FLOOR_USD,
    REPORT_CARD_MIN_RESPONDED,
  },
};
