'use strict';

/**
 * reviewTriageService — the review-triage agent (#9).
 *
 * Every pending `HumanReviewQueue` item (bundle validation failures, anchor
 * drift, promotion-judge rejections, …) gets a deterministic EVIDENCE PACK —
 * the reviewer reads a brief, not a forensic dump — plus ONE strict-JSON LLM
 * call that advises (never decides) on approve/reject/needs_human_judgment.
 * The dossier is stored as a `review_triage` AgentDecision row keyed to the
 * review item. The reviewer's REAL resolution (approve/reject) is the human
 * signal that closes the row: agree -> accepted, overrule -> adjusted.
 *
 * LLM-path decision (documented per Plan 6 Task 1 constraints): this file
 * lives under src/coding/services, and EVERY sibling coding service that
 * calls an LLM (capstoneEvaluator/scorer.js, compassCoder.js, drillPromotion.js)
 * goes through llmRouter + costTracker — never `src/config/aiProvider`, which
 * is exclusively a core (src/services) convention. None of llmRouter's
 * existing task IDs fit "advise a human reviewer on a triage brief" (they're
 * all content-generation/grading tasks), so this adds ONE new routing-table
 * entry, `review_triage_brief` (claude-sonnet-4-6 — the same "judgment" tier
 * as capstone_evaluator/compass_coder, not the bulk-grading haiku tier).
 * Every call — success AND failure — is recorded via costTracker.recordSpend
 * so the triage agent's own spend is never invisible to the ops sentinel
 * (Plan 6 Task 3), which audits LLMSpend for the zero-cost/spend-spike bug
 * classes. Bypassing that ledger here would be exactly the "ironic" gap the
 * plan's self-review calls out.
 *
 * All functions take an optional `deps` for test injection (repo convention:
 * zero network/DB in tests).
 */

const HumanReviewQueue = require('../models/humanReviewQueue.model');
const ArtifactBundle = require('../models/artifactBundle.model');
const EvaluationAnchor = require('../models/evaluationAnchor.model');
const CapstoneSession = require('../models/capstoneSession.model');
const AgentDecision = require('../../models/AgentDecision');
const { isAgentEnabled } = require('../../config/agentFlags');
const agentDecisionService = require('../../services/agentDecisionService');
const llmRouter = require('./llmRouter');
const costTracker = require('./costTracker');
const { parseLLMJson } = require('./drillGrader/parseLLMJson');

const TASK_ID = 'review_triage_brief';
const PROMPT_VERSION = 'triage-v1';
const RECENT_SESSIONS_LIMIT = 20;
const VALID_RECOMMENDATIONS = new Set(['approve', 'reject', 'needs_human_judgment']);
// Maps the human's REAL resolution to the enum the LLM recommendation uses,
// so closeOnResolution can compare like-for-like.
const RESOLUTION_TO_RECOMMENDATION = { approved: 'approve', rejected: 'reject' };

const SYSTEM_PROMPT = [
  'You advise a HUMAN reviewer who is deciding whether to approve or reject an',
  'item in a coding-content review queue. You do NOT make the decision — the',
  'human does. Base your assessment STRICTLY on the evidence pack given to',
  'you; do not infer or invent facts outside it, and cite the specific',
  'evidence fields (reason, bundle, anchor drift, session stats) that inform',
  'your recommendation.',
].join(' ');

function defaultDeps() {
  return {
    HumanReviewQueue,
    ArtifactBundle,
    EvaluationAnchor,
    CapstoneSession,
    AgentDecision,
    isAgentEnabled,
    record: agentDecisionService.record,
    llmCall: llmRouter.llmCall,
    recordSpend: costTracker.recordSpend,
    now: () => new Date(),
  };
}

// ── Evidence assembly (deterministic, null-safe) ──────────────────────────────

function round2(n) {
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function buildBundleEvidence(bundle) {
  if (!bundle) return null;
  return {
    id: bundle._id ? String(bundle._id) : null,
    type: bundle.type ?? null,
    drill_subtype: bundle.drill_subtype ?? null,
    role_track: bundle.role_track ?? null,
    language: bundle.language ?? null,
    difficulty: bundle.difficulty ?? null,
    // Bundles have no dedicated "title" field — the brief IS the title-ish
    // description the reviewer recognises the item by. Truncated so the
    // evidence pack (and the LLM prompt) stays small.
    brief: typeof bundle.brief === 'string' ? bundle.brief.slice(0, 400) : null,
  };
}

/**
 * Anchor-drift numbers — only meaningfully populated when the review reason
 * itself mentions drift (e.g. `capstone_anchor_drift session=...`, per
 * capstoneEvaluator/anchorDrift.js's reason strings). Null-safe: no bundle_id
 * or no anchors -> empty list, never throws.
 */
async function buildAnchorDriftEvidence({ bundleId, reason }, d) {
  const involvesDrift = typeof reason === 'string' && /drift/i.test(reason);
  if (!bundleId) return { involvesDrift, anchors: [] };

  const anchors = await d.EvaluationAnchor.find({ bundle_id: bundleId }).lean();
  const list = (anchors || []).map((a) => {
    const observations = Array.isArray(a.observed_scores) ? a.observed_scores : [];
    const drifts = observations.map((o) => o && o.drift).filter((n) => typeof n === 'number');
    const meanDrift = drifts.length ? drifts.reduce((s, n) => s + n, 0) / drifts.length : null;
    const maxDrift = drifts.length ? Math.max(...drifts) : null;
    return {
      anchor_id: a.anchor_id ?? null,
      expected_score: typeof a.expected_score === 'number' ? a.expected_score : null,
      observation_count: observations.length,
      mean_drift: round2(meanDrift),
      max_drift: round2(maxDrift),
    };
  });

  return { involvesDrift, anchors: list };
}

/**
 * Recent graded-session stats for the bundle: count, score spread,
 * integrity_confidence distribution, paste/blur activity. Paste/blur come
 * from CapstoneSession.counters (already fetched with the score fields in
 * the SAME query) rather than a per-session CapstoneRecording join — the
 * cheapest source available, per the Task 1 contract's "if cheaply
 * available". Null-safe defaults when the bundle has no graded sessions.
 */
async function buildSessionEvidence(bundleId, d) {
  const empty = {
    count: 0,
    avgScore: null,
    minScore: null,
    maxScore: null,
    integrityConfidence: { high: 0, medium: 0, low: 0, unknown: 0 },
    avgPasteEvents: null,
    avgTabBlurEvents: null,
  };
  if (!bundleId) return empty;

  const sessions = await d.CapstoneSession
    .find({ bundle_id: bundleId, status: 'graded' })
    .sort({ graded_at: -1 })
    .limit(RECENT_SESSIONS_LIMIT)
    .select('result.overall_score result.integrity_confidence counters.paste_events counters.tab_blur_events')
    .lean();

  const list = sessions || [];
  if (list.length === 0) return empty;

  const scores = list.map((s) => s && s.result && s.result.overall_score).filter((n) => typeof n === 'number');
  const integrityConfidence = { high: 0, medium: 0, low: 0, unknown: 0 };
  for (const s of list) {
    const c = s && s.result && s.result.integrity_confidence;
    if (c === 'high' || c === 'medium' || c === 'low') integrityConfidence[c] += 1;
    else integrityConfidence.unknown += 1;
  }
  const pastes = list.map((s) => s && s.counters && s.counters.paste_events).filter((n) => typeof n === 'number');
  const blurs = list.map((s) => s && s.counters && s.counters.tab_blur_events).filter((n) => typeof n === 'number');

  return {
    count: list.length,
    avgScore: scores.length ? round2(scores.reduce((s, n) => s + n, 0) / scores.length) : null,
    minScore: scores.length ? Math.min(...scores) : null,
    maxScore: scores.length ? Math.max(...scores) : null,
    integrityConfidence,
    avgPasteEvents: pastes.length ? round2(pastes.reduce((s, n) => s + n, 0) / pastes.length) : null,
    avgTabBlurEvents: blurs.length ? round2(blurs.reduce((s, n) => s + n, 0) / blurs.length) : null,
  };
}

function buildUserPrompt(evidence) {
  return [
    'Evidence pack for a pending human-review item. This is ALL the evidence',
    'you have — cite only fields present here, nothing else:',
    JSON.stringify(evidence, null, 2),
    '',
    'Return STRICT JSON only (no markdown fences, no prose outside the JSON):',
    '{ "assessment": "<2-4 sentences citing the evidence above>", "confidence": <0..1>, "recommendation": "approve"|"reject"|"needs_human_judgment" }',
  ].join('\n');
}

function validateRecommendation(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('LLM recommendation payload is not an object');
  }
  if (typeof parsed.assessment !== 'string' || !parsed.assessment.trim()) {
    throw new Error('LLM recommendation missing assessment');
  }
  const confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error('LLM recommendation confidence out of range');
  }
  if (!VALID_RECOMMENDATIONS.has(parsed.recommendation)) {
    throw new Error(`LLM recommendation invalid enum: ${parsed.recommendation}`);
  }
  return { assessment: parsed.assessment.trim(), confidence, recommendation: parsed.recommendation };
}

// ── buildDossier ───────────────────────────────────────────────────────────────

/**
 * buildDossier({ reviewItemId }, deps) -> Promise<{ evidence, recommendation } | null>
 *
 * Assembles the deterministic evidence pack, then makes ONE strict-JSON LLM
 * call for the advisory recommendation. Returns null only when the review
 * item itself can't be resolved (deleted / bad id). An LLM failure (network,
 * timeout, unparseable/invalid JSON) NEVER throws — the dossier still comes
 * back with the (still useful) evidence and `recommendation: null`.
 */
async function buildDossier({ reviewItemId }, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  if (!reviewItemId) return null;

  const item = await d.HumanReviewQueue.findById(reviewItemId).lean();
  if (!item) return null;

  const bundle = item.bundle_id ? await d.ArtifactBundle.findById(item.bundle_id).lean() : null;

  const evidence = {
    reviewItem: {
      id: String(item._id),
      reason: item.reason ?? null,
      status: item.status ?? null,
      validatorErrors: Array.isArray(item.validator_errors) ? item.validator_errors : [],
    },
    bundle: buildBundleEvidence(bundle),
    anchorDrift: await buildAnchorDriftEvidence({ bundleId: item.bundle_id, reason: item.reason }, d),
    sessions: await buildSessionEvidence(item.bundle_id, d),
  };

  let result;
  try {
    result = await d.llmCall({
      taskId: TASK_ID,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(evidence) }],
      temperature: 0,
    });
  } catch (err) {
    await d.recordSpend({
      result: { _meta: { taskId: TASK_ID, provider: 'anthropic' } },
      taskId: TASK_ID,
      outcome: err && err.name === 'AbortError' ? 'timeout' : 'error',
      errorClass: err && err.constructor && err.constructor.name,
    }).catch(() => {});
    return { evidence, recommendation: null };
  }

  // Spend is recorded for every SUCCESSFUL call regardless of whether the
  // JSON below parses/validates — tokens were consumed either way, and this
  // is the exact ledger the ops sentinel audits.
  await d.recordSpend({ result, taskId: TASK_ID, outcome: 'ok' }).catch(() => {});

  let recommendation = null;
  try {
    const parsed = parseLLMJson(result.content);
    recommendation = validateRecommendation(parsed);
  } catch (_err) {
    recommendation = null;
  }

  return { evidence, recommendation };
}

// ── triagePending ────────────────────────────────────────────────────────────

/**
 * triagePending(deps) -> Promise<{ triaged: n }>
 *
 * Flag-gated (`review_triage`, zero DB reads when off). For every pending
 * HumanReviewQueue item WITHOUT an existing OPEN (status: pending) dossier
 * row, builds a dossier and records it as a `review_triage` AgentDecision.
 * userId/institutionId are deliberately unset — this is an internal/ops
 * agent, not a user- or institution-scoped one. Per-item try/catch: one
 * item's failure never blocks the rest of the sweep.
 */
async function triagePending(deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  if (!d.isAgentEnabled('review_triage')) return { triaged: 0 };

  const pendingItems = (await d.HumanReviewQueue.find({ status: 'pending' }).select('_id').lean()) || [];

  let triaged = 0;
  for (const item of pendingItems) {
    const reviewItemId = item._id;
    try {
      const existing = await d.AgentDecision.findOne({
        agentId: 'review_triage',
        'action.reviewItemId': String(reviewItemId),
        status: 'pending',
      }).select('_id').lean();
      if (existing) continue; // dedup: already has an open dossier for this item

      const dossier = await buildDossier({ reviewItemId }, d);
      if (!dossier) continue; // item vanished between listing and building

      await d.record({
        agentId: 'review_triage',
        decisionType: 'brief',
        action: {
          kind: 'review_dossier',
          reviewItemId: String(reviewItemId),
          evidence: dossier.evidence,
          recommendation: dossier.recommendation,
        },
        promptVersion: PROMPT_VERSION,
      }, d);
      triaged += 1;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[reviewTriageService] triage failed for item', reviewItemId, err && err.message);
    }
  }

  return { triaged };
}

// ── closeOnResolution ────────────────────────────────────────────────────────

/**
 * closeOnResolution({ reviewItemId, resolution }, deps) -> Promise<{ closed }>
 *
 * The reviewer's REAL resolution ('approved' | 'rejected') closes the item's
 * latest OPEN (status: pending) dossier row:
 *   - recommendation matches the resolution  -> 'accepted'
 *   - recommendation mismatches (incl. 'needs_human_judgment', which never
 *     "matches" either resolution) -> 'adjusted' + adjustmentDiff.humanResolution
 *   - no LLM recommendation at all (evidence-only dossier) -> 'accepted'
 *     (nothing to overrule)
 * No open dossier row for the item -> no-op ({ closed: false }).
 */
async function closeOnResolution({ reviewItemId, resolution }, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  if (!reviewItemId) return { closed: false };

  const row = await d.AgentDecision.findOne({
    agentId: 'review_triage',
    'action.reviewItemId': String(reviewItemId),
    status: 'pending',
  }).sort({ createdAt: -1 });

  if (!row) return { closed: false };

  const recommendation = row.action && row.action.recommendation;
  const expected = RESOLUTION_TO_RECOMMENDATION[resolution];

  if (!recommendation || !recommendation.recommendation) {
    row.status = 'accepted';
  } else if (expected && recommendation.recommendation === expected) {
    row.status = 'accepted';
  } else {
    row.status = 'adjusted';
    row.adjustmentDiff = { humanResolution: resolution };
    // adjustmentDiff is Schema.Types.Mixed — flag it explicitly so a
    // whole-value reassignment is never silently dropped, same convention
    // as briefApprovalService.approveBrief's contextSnapshot stamp.
    row.markModified('adjustmentDiff');
  }

  row.respondedAt = (d.now && d.now()) || new Date();
  await row.save();

  return { closed: true };
}

module.exports = {
  buildDossier,
  triagePending,
  closeOnResolution,
  _helpers: {
    buildBundleEvidence,
    buildAnchorDriftEvidence,
    buildSessionEvidence,
    buildUserPrompt,
    validateRecommendation,
    TASK_ID,
    PROMPT_VERSION,
  },
};
