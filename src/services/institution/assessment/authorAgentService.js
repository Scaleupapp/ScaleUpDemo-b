'use strict';

/**
 * authorAgentService — engine-aware author agent: generate -> QA -> repair
 * (or, for engines whose repair loop already lives inside the engine itself,
 * generate -> QA -> honest status) with a decision-ledger-backed run.
 *
 * Every engine (mcq, interview, capstone, drill) ALREADY has its own
 * generate -> QA -> repair loop inside assessmentAuthoringService (mcq:
 * over-generate + 3-gate QA + regenerateQuestion; interview:
 * interviewPlanService's MAX_ROUNDS lint->judge->critique loop; capstone/
 * drill: the coding module's sandbox-proof + cross-model validation +
 * promotion pipeline, reached by polling). This service does NOT add new
 * intelligence — it dispatches to the right engine, narrates the REAL
 * pipeline into a human-readable runLog, and surfaces each engine's REAL
 * persisted evidence into one uniform result shape:
 *
 *   { status: 'ready'|'needs_review'|'failed', engine, evidence, flagged, passes }
 *
 * startRun records the AgentDecision row (action.engine = assessment.type)
 * and kicks the loop fire-and-forget (same pattern as the existing
 * institution routes' `authoring().authorMcq(a._id).catch(...)` calls);
 * runAuthoring drives it and NEVER throws — every failure is persisted onto
 * the decision row's action.result instead.
 *
 * MCQ QA-report seam (read, not invented — unchanged from the pre-existing
 * mcq-only implementation this file grew out of): authorMcq freezes ONLY the
 * QA-passed pool onto `assessment.config.mcq.questions`; rejected candidates
 * are discarded in-memory inside authorMcq's over-generation rounds and never
 * reach the Assessment doc, so there is no persisted "rejected index" to
 * target. The one per-item signal that DOES survive on a frozen, addressable
 * (by index, for regenerateQuestion) question is `q.qa.solver.ambiguous` —
 * questionQaService.runQa sets this true whenever the blind-solve gate's
 * agreement confidence is < 0.6 even though the item passed all three gates.
 * That is what this service treats as "repairable" for mcq.
 *
 * Interview evidence seam (read, not invented): authorInterview persists
 * `config.interview.authoring = { status, error, questionPlan }` where
 * questionPlan = `{ questions, judge, lint, rounds }` — exactly what
 * interviewPlanService.buildQuestionPlan returned on success. So judge
 * verdict/scores, lint pass/fail and round count ARE real persisted fields
 * on the Assessment doc; this service reads them, it does not recompute or
 * invent them. There is no per-agent repair loop for interview — the
 * engine's own MAX_ROUNDS critique loop already ran before authorInterview
 * resolved, so `passes` is reported as 0 (no agent-level repair pass ran).
 *
 * Capstone/drill evidence seam (read, not invented): both engines persist
 * only `config.<type>.bundleId` onto the Assessment; the rest of the
 * evidence (status, role_track, difficulty, language, drill_subtype,
 * generated_by.human_reviewed) lives on the ArtifactBundle doc itself, so
 * this service loads the bundle by id and maps its REAL enum state
 * (draft|validated|active|retired) onto ready/needs_review/failed. No
 * agent-level repair loop here either — the coding module's own
 * retry/cross-check/promotion pipeline IS the repair, so `passes` is 0.
 *
 * All functions take an optional `deps` for test injection (repo convention:
 * zero network/DB in tests).
 */

const AUTHORABLE_TYPES = ['mcq', 'interview', 'capstone', 'drill'];

// mcq/interview persist a cheap `config.<type>.authoring.status` flag we can
// check for "already generating". capstone/drill do NOT — their in-flight
// signal lives on CapstoneGenerationRequest / the generation pipeline, keyed
// by user_id (capstone) or nothing at all (drill), with no cheap link back to
// this assessmentId. Per the plan's contract, that sub-guard is skipped for
// those two engines rather than faked.
//
// That gap is what let a double-clicked "Run author agent" fire the full
// LLM generation + sandbox proof + cross-model check pipeline TWICE for
// capstone/drill (real duplicated spend + an orphaned ArtifactBundle) before
// the losing run failed on a version conflict at save. startRun's
// AgentDecision in-flight check below closes that gap uniformly for ALL
// FOUR engines — it does not replace the mcq/interview config-level guard
// above (belt and braces), it just adds the one signal that's cheaply
// knowable for every engine: an unfinished ledger row for this assessment.
const MID_GENERATION_GUARDED_ENGINES = ['mcq', 'interview'];

function defaultDeps() {
  return {
    AgentDecision: require('../../../models/AgentDecision'),
    Assessment: require('../../../models/Assessment'),
    ArtifactBundle: require('../../../coding/models/artifactBundle.model'),
    authoring: require('./assessmentAuthoringService'),
    record: require('../../agentDecisionService').record,
    isAgentEnabled: require('../../../config/agentFlags').isAgentEnabled,
    InstitutionCohort: require('../../../models/InstitutionCohort'),
    ObjectiveTemplate: require('../../../models/ObjectiveTemplate'),
    assessmentSpecService: require('./assessmentSpecService'),
    assessmentService: require('./assessmentService'),
  };
}

/**
 * buildObjectiveContext(template) -> { label, targetRole?, targetCompany?,
 *   targetSkill?, competencies? } | null
 *
 * Compacts an ObjectiveTemplate doc into the grounding context
 * assessmentSpecService.parseBrief expects — null-safe, omitting any
 * specifics field the template didn't set, and dropping competency rows
 * with no name.
 */
function buildObjectiveContext(template) {
  if (!template) return null;
  const specifics = template.specifics || {};
  const objective = { label: template.label };
  if (specifics.targetRole) objective.targetRole = specifics.targetRole;
  if (specifics.targetCompany) objective.targetCompany = specifics.targetCompany;
  if (specifics.targetSkill) objective.targetSkill = specifics.targetSkill;
  if (Array.isArray(template.competencies) && template.competencies.length) {
    const competencies = template.competencies
      .filter((c) => c && c.name)
      .map((c) => ({ name: c.name, weight: c.weight }));
    if (competencies.length) objective.competencies = competencies;
  }
  return objective;
}

/**
 * loadCohortContext({ institutionId, cohortId }, d)
 *   -> Promise<{ cohortLabel, objective }>
 *
 * Best-effort context for the parseBrief prompt only — NOT an ownership
 * guard (createAssessment remains the single source of truth for that).
 * Grounds the brief in the cohort's ObjectiveTemplate (via
 * InstitutionCohort.objectiveTemplateId) when the cohort has one; silently
 * falls back to { objective: null } on any lookup failure or when the
 * cohort has no objectiveTemplateId, so an unresolved objective only ever
 * means a slightly less specific prompt, never a failed run.
 */
async function loadCohortContext({ institutionId, cohortId }, d) {
  let cohortLabel;
  let objective = null;
  try {
    const cohort = await d.InstitutionCohort.findOne({ _id: cohortId, institutionId }).select(
      'name label objectiveTemplateId'
    );
    cohortLabel = cohort && (cohort.name || cohort.label);
    if (cohort && cohort.objectiveTemplateId) {
      const template = await d.ObjectiveTemplate.findById(cohort.objectiveTemplateId).select(
        'label specifics competencies'
      );
      objective = buildObjectiveContext(template);
    }
  } catch (_) {
    // best-effort — an unresolved cohort/objective just means a less specific prompt
  }
  return { cohortLabel, objective };
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

/** config.<type>.authoring.status — the honest generating/ready/failed flag mcq + interview persist. */
function authoringStatusFor(assessment, type) {
  return (
    (assessment &&
      assessment.config &&
      assessment.config[type] &&
      assessment.config[type].authoring &&
      assessment.config[type].authoring.status) ||
    null
  );
}

/** Back-compat name used internally by the mcq runner. */
function mcqAuthoringStatus(assessment) {
  return authoringStatusFor(assessment, 'mcq');
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
 * startRun({ assessmentId, institutionId, cohortId, actorInstitutionUserId, brief, createdByAgent }, deps)
 *   -> Promise<{ decisionId }>
 *
 * Guards: agent flag on; assessment exists and belongs to institutionId;
 * assessment.type is one of the four authorable engines; assessment.status
 * in [draft, configured]; for mcq/interview only, that engine's
 * config.<type>.authoring.status isn't already 'generating' (capstone/drill
 * have no cheap in-flight signal — see MID_GENERATION_GUARDED_ENGINES above);
 * and — across all four engines — no author_agent AgentDecision row for this
 * assessmentId is still unfinished (action.result null/absent), which is
 * what stops a double-click from firing the full generation pipeline twice.
 * Records the AgentDecision row (action.engine = assessment.type, userId
 * stays unset — this is an institution-side agent), then fires runAuthoring
 * in the background.
 *
 * `createdByAgent` (optional, default false): when true, `action.createdByAgent
 * = true` is written INTO the record() payload itself, atomically at row
 * creation — before runAuthoring is kicked. This must never be set via a
 * post-hoc findById/save on the row: runAuthoring's fire-and-forget loop
 * concurrently mutates and saves action.runLog/action.result on the same row,
 * so any save issued after startRun returns risks reading a stale copy and
 * clobbering whatever the run has written in the meantime. Callers that don't
 * pass the flag (or pass false) see byte-identical behavior to before — no
 * `createdByAgent` key is added to the action object at all.
 */
async function startRun(
  { assessmentId, institutionId, cohortId, actorInstitutionUserId, brief, createdByAgent = false },
  deps = {}
) {
  const d = { ...defaultDeps(), ...deps };

  if (!d.isAgentEnabled('author_agent')) throw new Error('author agent disabled');

  const assessment = await d.Assessment.findById(assessmentId);
  if (!assessment || String(assessment.institutionId) !== String(institutionId)) {
    throw new Error('assessment not found');
  }

  const engine = assessment.type;
  if (!AUTHORABLE_TYPES.includes(engine)) throw new Error('assessment not authorable');

  const statusOk = ['draft', 'configured'].includes(assessment.status);
  const midGeneration =
    MID_GENERATION_GUARDED_ENGINES.includes(engine) && authoringStatusFor(assessment, engine) === 'generating';
  if (!statusOk || midGeneration) throw new Error('assessment not authorable');

  // Uniform agent-level guard for ALL four engines: an author_agent ledger
  // row for this assessment is only finalized (action.result set) when the
  // run ends, so an unfinished row means a run is genuinely in flight right
  // now — reject rather than kick off a second full generation pipeline.
  const inFlightRun = await d.AgentDecision.findOne({
    agentId: 'author_agent',
    'action.assessmentId': String(assessmentId),
    'action.result': null,
  })
    .select('_id')
    .lean();
  if (inFlightRun) throw new Error('assessment authoring already in progress');

  const decision = await d.record(
    {
      agentId: 'author_agent',
      decisionType: 'artifact',
      institutionId,
      cohortId,
      contextSnapshot: { actorInstitutionUserId, brief },
      action: {
        kind: 'assessment_authoring_run',
        engine,
        brief,
        assessmentId: String(assessmentId),
        runLog: [{ at: new Date(), msg: 'run queued' }],
        result: null,
        ...(createdByAgent ? { createdByAgent: true } : {}),
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
 * createAndAuthor({ institutionId, cohortId, actorInstitutionUserId, brief }, deps)
 *   -> Promise<{ assessmentId, decisionId, spec }>
 *
 * The one-prompt path: a TPO describes the assessment they want in free text
 * — no pre-existing shell, no picker. Turns the brief into a validated
 * create-assessment payload (assessmentSpecService.parseBrief), creates the
 * Assessment (assessmentService.createAssessment — which already enforces
 * the cohort-belongs-to-institution guard and per-type config validation),
 * then reuses the EXISTING startRun/runAuthoring generate -> QA -> repair
 * pipeline on the freshly created assessment. Does not reimplement any of
 * that logic — it is the same run a TPO gets by hand-configuring an
 * assessment and clicking "run author agent".
 *
 * Guarded by the same `author_agent` flag startRun checks; checked again
 * here up front so a disabled flag never even reaches the LLM call.
 *
 * Never throws anything but the three named errors this feature promises
 * ('author agent disabled' | 'cohort not found' | 'could not understand the
 * brief') plus whatever createAssessment/startRun themselves throw for other
 * genuine failures (e.g. a bad opens/closes window) — those are not this
 * feature's to hide.
 */
async function createAndAuthor({ institutionId, cohortId, actorInstitutionUserId, brief }, deps = {}) {
  const d = { ...defaultDeps(), ...deps };

  if (!d.isAgentEnabled('author_agent')) throw new Error('author agent disabled');

  // Best-effort context for the prompt only — NOT the cohort-ownership guard.
  // createAssessment (below) is the single source of truth for that check.
  // Grounds the brief in the cohort's ObjectiveTemplate (if it has one) —
  // see loadCohortContext / assessmentSpecService's file-level doc comment.
  const { cohortLabel, objective } = await loadCohortContext({ institutionId, cohortId }, d);

  let spec;
  try {
    spec = await d.assessmentSpecService.parseBrief({ brief, cohortLabel, objective }, d);
  } catch (_err) {
    throw new Error('could not understand the brief');
  }

  let assessment;
  try {
    assessment = await d.assessmentService.createAssessment(
      { institutionId },
      {
        cohortId,
        type: spec.type,
        title: spec.title,
        config: spec.config,
        opensAt: spec.opensAt,
        closesAt: spec.closesAt,
        createdBy: actorInstitutionUserId,
      },
      d
    );
  } catch (err) {
    if (err && err.message === 'COHORT_NOT_FOUND') throw new Error('cohort not found');
    throw err;
  }

  // createdByAgent: true is passed straight into startRun's record() payload
  // so it's written atomically at row creation — before runAuthoring's
  // fire-and-forget loop starts concurrently mutating/saving this same row's
  // action.runLog/action.result. No post-hoc findById/save here: that pattern
  // used to race the running job and could clobber a runLog entry or the
  // final result with a stale read.
  const { decisionId } = await startRun(
    { assessmentId: assessment._id, institutionId, cohortId, actorInstitutionUserId, brief, createdByAgent: true },
    d
  );

  return { assessmentId: assessment._id, decisionId, spec };
}

// ── mcq runner ──────────────────────────────────────────────────────────────

function mcqResult(status, { totalQuestions, regenerated, flaggedIndices, passes }) {
  return {
    status,
    engine: 'mcq',
    // Back-compat top-level fields (pre-existing shape callers may already read).
    totalQuestions,
    regenerated,
    flaggedIndices,
    passes,
    // Uniform contract fields.
    evidence: { totalQuestions, regenerated, flaggedIndices, passes },
    flagged: flaggedIndices,
  };
}

/**
 * Bounded loop: authorMcq -> read the frozen pool's per-item QA flags ->
 * up to AUTHOR_AGENT_MAX_REPAIR_PASSES passes of regenerateQuestion against
 * the flagged indices -> uniform result. EXACTLY today's behavior, just
 * returning the new uniform shape (with the old fields mirrored at top
 * level) instead of persisting directly.
 */
async function runMcqEngine({ decisionId, assessmentId }, d) {
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
      return mcqResult('failed', { totalQuestions: 0, regenerated: 0, flaggedIndices: [], passes: 0 });
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
      return mcqResult('failed', { totalQuestions: 0, regenerated: 0, flaggedIndices: [], passes: 0 });
    }

    const questions = assessment.config.mcq.questions || [];
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

    return mcqResult(finalStatus, { totalQuestions, regenerated, flaggedIndices, passes });
  } catch (err) {
    // Catch-all: a bug anywhere above must still leave an honest result, never throw.
    try {
      await appendLog(d.AgentDecision, decisionId, `run crashed: ${err && err.message}`);
    } catch (_) { /* best-effort */ }
    return mcqResult('failed', { totalQuestions, regenerated, flaggedIndices, passes: passesUsed });
  }
}

// ── interview runner ─────────────────────────────────────────────────────────

function interviewResult(status, evidence) {
  return { status, engine: 'interview', evidence, flagged: [], passes: 0 };
}

/**
 * Calls authorInterview (which runs interviewPlanService.buildQuestionPlan's
 * own MAX_ROUNDS lint -> judge -> critique loop internally), then reads the
 * REAL persisted `config.interview.authoring` off the Assessment doc. No
 * agent-level repair pass — the engine's own critique loop already ran.
 */
async function runInterviewEngine({ decisionId, assessmentId }, d) {
  try {
    await appendLog(d.AgentDecision, decisionId, 'question-plan generation started');

    try {
      await d.authoring.authorInterview(assessmentId, d);
    } catch (err) {
      await appendLog(d.AgentDecision, decisionId, `authoring failed: ${err && err.message}`);
      return interviewResult('failed', {});
    }

    const assessment = await d.Assessment.findById(assessmentId);
    const authoring =
      (assessment && assessment.config && assessment.config.interview && assessment.config.interview.authoring) || {};

    if (authoring.status !== 'ready') {
      const err = authoring.error || 'authoring did not reach ready status';
      await appendLog(d.AgentDecision, decisionId, `authoring gate failed: ${err}`);
      return interviewResult('failed', {});
    }

    const plan = authoring.questionPlan || {};
    const questions = Array.isArray(plan.questions) ? plan.questions : [];
    const judge = plan.judge || null;
    const lint = plan.lint || null;
    const evidence = {
      questionCount: questions.length,
      rounds: plan.rounds != null ? plan.rounds : null,
      judgeVerdict: judge ? judge.verdict : null,
      judgeScores: judge ? judge.scores : null,
      lintPassed: lint ? lint.passed : null,
    };
    await appendLog(
      d.AgentDecision,
      decisionId,
      `ready — ${questions.length} questions planned over ${evidence.rounds || '?'} round(s) · judge: ${evidence.judgeVerdict || 'n/a'}`
    );
    return interviewResult('ready', evidence);
  } catch (err) {
    try {
      await appendLog(d.AgentDecision, decisionId, `run crashed: ${err && err.message}`);
    } catch (_) { /* best-effort */ }
    return interviewResult('failed', {});
  }
}

// ── capstone / drill (bundle) runner ─────────────────────────────────────────

function bundleResult(type, status, evidence) {
  return { status, engine: type, evidence, flagged: [], passes: 0 };
}

/**
 * Shared capstone/drill runner: both engines kick coding-module generation
 * then poll internally until a bundle exists (or throw on failure/timeout),
 * setting `config.<type>.bundleId`. This runner then loads the REAL
 * ArtifactBundle and maps its real `status` enum (draft|validated|active|
 * retired) onto ready/needs_review/failed. No agent-level repair pass — the
 * coding module's own retry/cross-check/promotion pipeline IS the repair.
 */
async function runBundleEngine(type, { decisionId, assessmentId }, d) {
  try {
    await appendLog(d.AgentDecision, decisionId, 'generation requested');

    const authorFn = type === 'capstone' ? d.authoring.authorCapstone : d.authoring.authorDrill;
    try {
      await authorFn(assessmentId, d);
    } catch (err) {
      await appendLog(d.AgentDecision, decisionId, `authoring failed: ${err && err.message}`);
      return bundleResult(type, 'failed', {});
    }

    const assessment = await d.Assessment.findById(assessmentId);
    const cfg = (assessment && assessment.config && assessment.config[type]) || {};
    const bundleId = cfg.bundleId;

    if (!bundleId) {
      await appendLog(d.AgentDecision, decisionId, 'no bundle produced — authoring did not complete');
      return bundleResult(type, 'failed', {});
    }

    const bundle = await d.ArtifactBundle.findById(bundleId);
    if (!bundle) {
      await appendLog(d.AgentDecision, decisionId, `bundle ${bundleId} not found`);
      return bundleResult(type, 'failed', { bundleId: String(bundleId) });
    }

    const evidence = {
      bundleId: String(bundleId),
      bundleStatus: bundle.status,
      roleTrack: bundle.role_track,
      difficulty: bundle.difficulty,
      language: bundle.language,
      humanReviewed: !!(bundle.generated_by && bundle.generated_by.human_reviewed),
    };
    if (type === 'drill') evidence.drillSubtype = bundle.drill_subtype;

    let status;
    if (bundle.status === 'active') {
      status = 'ready';
      await appendLog(d.AgentDecision, decisionId, 'bundle validated (sandbox + cross-model) and promoted to active');
    } else if (bundle.status === 'validated') {
      status = 'needs_review';
      await appendLog(d.AgentDecision, decisionId, 'bundle validated (sandbox + cross-model) — awaiting promotion to active');
    } else {
      status = 'failed';
      await appendLog(d.AgentDecision, decisionId, `bundle status '${bundle.status}' — not usable`);
    }

    return bundleResult(type, status, evidence);
  } catch (err) {
    try {
      await appendLog(d.AgentDecision, decisionId, `run crashed: ${err && err.message}`);
    } catch (_) { /* best-effort */ }
    return bundleResult(type, 'failed', {});
  }
}

// ── dispatcher ────────────────────────────────────────────────────────────

/**
 * runAuthoring({ decisionId, assessmentId }, deps) -> Promise<void>
 *
 * Reads the assessment's `type` and dispatches to the matching per-engine
 * runner (mcq/interview/capstone/drill), then persists the uniform result
 * onto the decision row. Every stage is try/caught inside the per-engine
 * runners; this dispatcher wraps the whole thing in one more catch-all so a
 * bug anywhere — including a crash reading the assessment's type itself —
 * still leaves an honest 'failed' result. NEVER throws.
 */
async function runAuthoring({ decisionId, assessmentId }, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  let engine = 'mcq'; // default matches this service's pre-multi-engine behavior

  try {
    const assessment = await d.Assessment.findById(assessmentId);
    engine = (assessment && assessment.type) || engine;

    let result;
    switch (engine) {
      case 'mcq':
        result = await runMcqEngine({ decisionId, assessmentId }, d);
        break;
      case 'interview':
        result = await runInterviewEngine({ decisionId, assessmentId }, d);
        break;
      case 'capstone':
        result = await runBundleEngine('capstone', { decisionId, assessmentId }, d);
        break;
      case 'drill':
        result = await runBundleEngine('drill', { decisionId, assessmentId }, d);
        break;
      default:
        await appendLog(d.AgentDecision, decisionId, `unsupported engine '${engine}'`);
        result = { status: 'failed', engine, evidence: {}, flagged: [], passes: 0 };
    }

    await finalizeResult(d.AgentDecision, decisionId, result);
  } catch (err) {
    try {
      await appendLog(d.AgentDecision, decisionId, `run crashed: ${err && err.message}`);
    } catch (_) { /* best-effort */ }
    try {
      await finalizeResult(d.AgentDecision, decisionId, {
        status: 'failed',
        engine,
        evidence: {},
        flagged: [],
        passes: 0,
      });
    } catch (_) { /* best-effort */ }
  }
}

/**
 * reapOrphanedRuns({ olderThanMinutes }, deps) -> Promise<{ reaped }>
 *
 * runAuthoring is fired fire-and-forget from startRun (same pattern as the
 * pre-existing institution routes' `authoring().authorMcq(a._id).catch(...)`
 * calls) — if the process dies or the server restarts mid-run, nothing ever
 * finalizes that AgentDecision row's `action.result`, which is exactly the
 * signal startRun's in-flight guard reads as "a run is genuinely in
 * progress". Left alone, an orphaned row permanently blocks that assessment
 * from ever being re-authored, and (for mcq/interview) the Assessment's own
 * `config.<engine>.authoring.status` is stuck reading 'generating' forever
 * too. This sweep finds author_agent rows that have been unfinished for
 * longer than any real run could possibly take, closes them out honestly as
 * 'failed', and resets the stuck engine-side flag so the TPO can retry.
 *
 * Real runs finish in minutes, so anything still open past the window
 * cannot still be alive — it's a corpse from a dead process, not a slow run.
 * Per-row try/catch: one bad row must never stop the rest of the sweep, and
 * this function itself never throws.
 */
async function reapOrphanedRuns(
  { olderThanMinutes = Number(process.env.AUTHOR_AGENT_ORPHAN_MINUTES || 30) } = {},
  deps = {}
) {
  const d = { ...defaultDeps(), ...deps };
  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);

  let rows = [];
  try {
    rows = await d.AgentDecision.find({
      agentId: 'author_agent',
      'action.result': null,
      createdAt: { $lt: cutoff },
    }).exec();
  } catch (_) {
    return { reaped: 0 };
  }

  let reaped = 0;

  for (const row of rows || []) {
    try {
      row.action = row.action || {};
      const engine = row.action.engine || null;
      const assessmentId = row.action.assessmentId;

      row.action.runLog = Array.isArray(row.action.runLog) ? row.action.runLog : [];
      row.action.runLog.push({
        at: new Date(),
        msg: 'run orphaned — the server restarted or the process died before this finished',
      });
      row.action.result = {
        status: 'failed',
        engine,
        evidence: {},
        flagged: [],
        passes: 0,
        note: 'orphaned',
      };
      row.markModified('action');
      await row.save();
      reaped += 1;

      if (assessmentId && MID_GENERATION_GUARDED_ENGINES.includes(engine)) {
        try {
          await d.Assessment.updateOne(
            { _id: assessmentId, [`config.${engine}.authoring.status`]: 'generating' },
            {
              $set: {
                [`config.${engine}.authoring.status`]: 'failed',
                [`config.${engine}.authoring.error`]: 'run orphaned',
              },
            }
          );
        } catch (_) {
          // Best-effort — the ledger row itself is already reaped, which is
          // what unblocks startRun's in-flight guard; the stuck UI flag is a
          // secondary cleanup.
        }
      }
    } catch (_) {
      // Per-row isolation — never let one bad row abort the sweep.
    }
  }

  return { reaped };
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
  reapOrphanedRuns,
  createAndAuthor,
  _helpers: { computeFlaggedIndices, mcqAuthoringStatus, authoringStatusFor, buildObjectiveContext, loadCohortContext },
};
