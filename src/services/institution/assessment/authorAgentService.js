'use strict';

/**
 * authorAgentService — the author agent's bounded generate -> QA -> repair loop.
 *
 * Wraps assessmentAuthoringService.authorMcq/regenerateQuestion with a
 * decision-ledger-backed run: startRun records the AgentDecision row and
 * kicks the loop fire-and-forget (same pattern as the existing institution
 * routes' `authoring().authorMcq(a._id).catch(...)` calls); runAuthoring
 * drives the loop and NEVER throws — every failure is persisted onto the
 * decision row's action.result instead.
 *
 * QA-report seam (read, not invented): authorMcq freezes ONLY the
 * QA-passed pool onto `assessment.config.mcq.questions`; rejected candidates
 * are discarded in-memory inside authorMcq's over-generation rounds and never
 * reach the Assessment doc, so there is no persisted "rejected index" to
 * target. The one per-item signal that DOES survive on a frozen, addressable
 * (by index, for regenerateQuestion) question is `q.qa.solver.ambiguous` —
 * questionQaService.runQa sets this true whenever the blind-solve gate's
 * agreement confidence is < 0.6 even though the item passed all three gates.
 * That is what this service treats as "repairable": low-confidence-but-passed
 * items worth a regeneration attempt. `assessment.config.mcq.authoring.status`
 * (generating/ready/failed) and its cumulative `qaReport` are set-level only
 * (rounds/totalGenerated/totalRejected/rejectionReasons) — useful for the log
 * line, useless for indexing a repair.
 *
 * All functions take an optional `deps` for test injection (repo convention:
 * zero network/DB in tests).
 */

function defaultDeps() {
  return {
    AgentDecision: require('../../../models/AgentDecision'),
    Assessment: require('../../../models/Assessment'),
    authoring: require('./assessmentAuthoringService'),
    record: require('../../agentDecisionService').record,
    isAgentEnabled: require('../../../config/agentFlags').isAgentEnabled,
  };
}

/** Indices in config.mcq.questions whose QA solver gate passed on low confidence. */
function computeFlaggedIndices(assessment) {
  const questions =
    (assessment && assessment.config && assessment.config.mcq && assessment.config.mcq.questions) || [];
  const indices = [];
  questions.forEach((q, i) => {
    if (q && q.qa && q.qa.solver && q.qa.solver.ambiguous === true) indices.push(i);
  });
  return indices;
}

function mcqAuthoringStatus(assessment) {
  return (
    (assessment &&
      assessment.config &&
      assessment.config.mcq &&
      assessment.config.mcq.authoring &&
      assessment.config.mcq.authoring.status) ||
    null
  );
}

/** findById -> mutate action.runLog -> markModified('action') -> save. */
async function appendLog(AgentDecision, decisionId, msg) {
  const row = await AgentDecision.findById(decisionId);
  if (!row) return;
  row.action = row.action || {};
  row.action.runLog = Array.isArray(row.action.runLog) ? row.action.runLog : [];
  row.action.runLog.push({ at: new Date(), msg });
  row.markModified('action');
  await row.save();
}

/** findById -> mutate action.result -> markModified('action') -> save. */
async function finalizeResult(AgentDecision, decisionId, result) {
  const row = await AgentDecision.findById(decisionId);
  if (!row) return;
  row.action = row.action || {};
  row.action.result = result;
  row.markModified('action');
  await row.save();
}

/**
 * startRun({ assessmentId, institutionId, cohortId, actorInstitutionUserId, brief }, deps)
 *   -> Promise<{ decisionId }>
 *
 * Guards: agent flag on; assessment exists and belongs to institutionId;
 * assessment.status in [draft, configured] and mcq authoring isn't already
 * 'generating'. Records the AgentDecision row (userId stays unset — this is
 * an institution-side agent), then fires runAuthoring in the background.
 */
async function startRun({ assessmentId, institutionId, cohortId, actorInstitutionUserId, brief }, deps = {}) {
  const d = { ...defaultDeps(), ...deps };

  if (!d.isAgentEnabled('author_agent')) throw new Error('author agent disabled');

  const assessment = await d.Assessment.findById(assessmentId);
  if (!assessment || String(assessment.institutionId) !== String(institutionId)) {
    throw new Error('assessment not found');
  }

  const authorable =
    ['draft', 'configured'].includes(assessment.status) && mcqAuthoringStatus(assessment) !== 'generating';
  if (!authorable) throw new Error('assessment not authorable');

  const decision = await d.record(
    {
      agentId: 'author_agent',
      decisionType: 'artifact',
      institutionId,
      cohortId,
      contextSnapshot: { actorInstitutionUserId, brief },
      action: {
        kind: 'assessment_authoring_run',
        brief,
        assessmentId: String(assessmentId),
        runLog: [{ at: new Date(), msg: 'run queued' }],
        result: null,
      },
      promptVersion: 'author-agent-v1',
    },
    d
  );

  const decisionId = decision._id;
  runAuthoring({ decisionId, assessmentId }, d).catch(console.warn);

  return { decisionId };
}

/**
 * runAuthoring({ decisionId, assessmentId }, deps) -> Promise<void>
 *
 * Bounded loop: authorMcq -> read the frozen pool's per-item QA flags ->
 * up to AUTHOR_AGENT_MAX_REPAIR_PASSES passes of regenerateQuestion against
 * the flagged indices -> final result persisted onto the decision row.
 * Every stage is try/caught; this function never throws.
 */
async function runAuthoring({ decisionId, assessmentId }, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  const MAX_PASSES = Number(process.env.AUTHOR_AGENT_MAX_REPAIR_PASSES || 2);

  let totalQuestions = 0;
  let flaggedIndices = [];
  let regenerated = 0;
  let passesUsed = 0;

  try {
    await appendLog(d.AgentDecision, decisionId, 'authoring started');

    let assessment;
    try {
      assessment = await d.authoring.authorMcq(assessmentId, d);
    } catch (err) {
      await appendLog(d.AgentDecision, decisionId, `authoring failed: ${err && err.message}`);
      await finalizeResult(d.AgentDecision, decisionId, {
        status: 'failed',
        totalQuestions: 0,
        regenerated: 0,
        flaggedIndices: [],
        passes: 0,
      });
      return;
    }

    // Re-read canonical state — authorMcq persists via Assessment.updateOne
    // internally, so the returned doc is not guaranteed to be the freshest
    // read path for a test double / a concurrent writer.
    assessment = await d.Assessment.findById(assessmentId);
    const status = mcqAuthoringStatus(assessment);

    if (status !== 'ready') {
      const err =
        (assessment &&
          assessment.config &&
          assessment.config.mcq &&
          assessment.config.mcq.authoring &&
          assessment.config.mcq.authoring.error) ||
        'authoring did not reach ready status';
      await appendLog(d.AgentDecision, decisionId, `authoring gate failed: ${err}`);
      await finalizeResult(d.AgentDecision, decisionId, {
        status: 'failed',
        totalQuestions: 0,
        regenerated: 0,
        flaggedIndices: [],
        passes: 0,
      });
      return;
    }

    const questions = (assessment.config.mcq.questions) || [];
    totalQuestions = questions.length;
    flaggedIndices = computeFlaggedIndices(assessment);
    await appendLog(
      d.AgentDecision,
      decisionId,
      `${totalQuestions} generated · QA gate: ${flaggedIndices.length} flagged low-confidence`
    );

    while (flaggedIndices.length > 0 && passesUsed < MAX_PASSES) {
      passesUsed += 1;
      await appendLog(
        d.AgentDecision,
        decisionId,
        `pass ${passesUsed}: regenerating ${flaggedIndices.length} flagged question(s)`
      );

      for (const idx of flaggedIndices) {
        try {
          await d.authoring.regenerateQuestion(assessmentId, idx, d);
          regenerated += 1;
        } catch (err) {
          await appendLog(
            d.AgentDecision,
            decisionId,
            `pass ${passesUsed}: regenerate index ${idx} failed: ${err && err.message}`
          );
        }
      }

      assessment = await d.Assessment.findById(assessmentId);
      flaggedIndices = computeFlaggedIndices(assessment);
      await appendLog(
        d.AgentDecision,
        decisionId,
        `pass ${passesUsed}: regenerated ${regenerated} · ${flaggedIndices.length} still flagged`
      );
    }

    const passes = Math.max(passesUsed, 1);
    let finalStatus;
    if (flaggedIndices.length === 0) {
      finalStatus = 'ready';
      await appendLog(d.AgentDecision, decisionId, `ready — ${totalQuestions} questions, ${regenerated} regenerated`);
    } else {
      finalStatus = 'needs_review';
      await appendLog(d.AgentDecision, decisionId, `${flaggedIndices.length} flagged for human review`);
    }

    await finalizeResult(d.AgentDecision, decisionId, {
      status: finalStatus,
      totalQuestions,
      regenerated,
      flaggedIndices,
      passes,
    });
  } catch (err) {
    // Catch-all: a bug anywhere above must still leave an honest result, never throw.
    try {
      await appendLog(d.AgentDecision, decisionId, `run crashed: ${err && err.message}`);
    } catch (_) { /* best-effort */ }
    try {
      await finalizeResult(d.AgentDecision, decisionId, {
        status: 'failed',
        totalQuestions,
        regenerated,
        flaggedIndices,
        passes: passesUsed,
      });
    } catch (_) { /* best-effort */ }
  }
}

/**
 * getRunStatus({ decisionId, institutionId }, deps) -> Promise<{ status, runLog, result }>
 *
 * Institution-scoped read for polling. status is result?.status || 'generating'.
 */
async function getRunStatus({ decisionId, institutionId }, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  const row = await d.AgentDecision.findById(decisionId);
  if (!row || String(row.institutionId) !== String(institutionId)) {
    throw new Error('run not found');
  }
  const result = (row.action && row.action.result) || null;
  const runLog = (row.action && row.action.runLog) || [];
  return { status: (result && result.status) || 'generating', runLog, result };
}

module.exports = {
  startRun,
  runAuthoring,
  getRunStatus,
  _helpers: { computeFlaggedIndices, mcqAuthoringStatus },
};
