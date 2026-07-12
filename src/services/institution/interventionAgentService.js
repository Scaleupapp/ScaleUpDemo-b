'use strict';

/**
 * interventionAgentService — the cohort intervention agent (#3).
 *
 * Weekly, per cohort: read the existing funnel/session/rollup evidence and
 * cluster at-risk students into three deterministic buckets. Nothing is sent
 * to a student here — this service only writes a PENDING AgentDecision
 * 'brief' row per qualifying cohort; a TPO approves (all-or-subset) before
 * any `notify_students` action actually fires (Task 3, a later plan step).
 *
 * Zero LLM calls: clustering is pure deterministic aggregation over
 * CohortRollup / AssessmentSession / InstitutionEnrollment. LLM-drafted,
 * per-student copy is a later enhancement once the ledger shows acceptance
 * rates on this hand-written, honest copy.
 *
 * All functions take an optional `deps` for test injection (repo convention:
 * zero network/DB in tests).
 */

// weak_competency threshold — read from the REAL byCompetency semantics
// (cohortRollupService.computeByCompetency): avgScore is always normalized to
// a 0-100 scale before it lands on the rollup (mcq: competencyBreakdown
// percentage; interview: dimensions[].score already 0-100; capstone:
// dimension_scores scaled *10 from its native 0-10; drill: rubric_breakdown
// score already 0-100). A student's PER-SESSION score for that same
// competency name lives on the raw engine payload we already read to build
// that aggregate — so it's on the same 0-100 scale.
//
// Chosen threshold: an ABSOLUTE cut of score < 40, not a percentile/decile.
// A percentile "bottom decile" is meaningless (and noisy) for the small
// cohort sizes this platform actually runs (tens of students, sometimes
// fewer per competency once you filter to graded sessions on the cohort's
// single weakest competency) — a 6-student cohort has no stable decile. An
// absolute score < 40 on a 0-100 competency scale is an honest, portable
// "failing" bar a TPO can defend regardless of cohort size, and it matches
// the failing-grade convention already used elsewhere on this platform.
// Strictly-less-than: a student who scores exactly 40 is NOT flagged.
const WEAK_COMPETENCY_THRESHOLD = 40;

// inactive boundary — 14 days, per the plan's contract. AssessmentSession
// rows are created ONLY when a student actually starts an assessment
// (assessmentSessionService.startSession creates the row and immediately
// flips it to 'in_progress' in the same call — there is no persisted
// "assigned but not yet started" row). So "zero AssessmentSession activity"
// for a student is equivalent to "this student has never started anything,
// ever" — there is no lesser signal (like a stale session) to distinguish
// "went quiet recently" from "never engaged at all". To keep this cluster
// honestly distinct from `not_started` (which is scoped to CURRENTLY
// released assessments only, with no time gate — a student who joined
// yesterday can land there), `inactive` is gated by ENROLLMENT AGE: it only
// flags students who have been enrolled for at least INACTIVE_WINDOW_DAYS
// AND have zero AssessmentSession rows in the cohort. That is the platform's
// only honest reading of "zero activity in the last 14 days AND no started
// assessment" given the real data shape. Boundary: enrolled EXACTLY 14 days
// ago is included (<=); 13 days ago is not.
const INACTIVE_WINDOW_DAYS = 14;

function defaultDeps() {
  return {
    Assessment: require('../../models/Assessment'),
    AssessmentSession: require('../../models/AssessmentSession'),
    InstitutionEnrollment: require('../../models/InstitutionEnrollment'),
    CohortRollup: require('../../models/CohortRollup'),
    InstitutionCohort: require('../../models/InstitutionCohort'),
    record: require('../agentDecisionService').record,
    isAgentEnabled: require('../../config/agentFlags').isAgentEnabled,
    listCandidateCohorts,
    now: () => new Date(),
  };
}

/**
 * Read a single named competency's score off one graded session's raw engine
 * payload, using the SAME per-engine-type extraction as
 * cohortRollupService.computeByCompetency (kept in sync deliberately — this
 * is the per-student mirror of that cohort-wide aggregate). Returns null when
 * the session has no raw payload, an unknown engine type, or no entry for
 * this competency.
 */
function extractCompetencyScore(session, competencyName) {
  const raw = session && session.result && session.result.raw;
  if (!raw) return null;
  const engineType = session.engine && session.engine.type;

  if (engineType === 'mcq') {
    const breakdown = raw.competencyBreakdown;
    if (!Array.isArray(breakdown)) return null;
    const entry = breakdown.find((e) => e && e.competency === competencyName && typeof e.percentage === 'number');
    return entry ? entry.percentage : null;
  }
  if (engineType === 'interview') {
    const dims = raw.dimensions;
    if (!dims || typeof dims !== 'object') return null;
    const val = dims[competencyName];
    return val && typeof val.score === 'number' ? val.score : null;
  }
  if (engineType === 'capstone') {
    const dimScores = raw.dimension_scores;
    if (!dimScores || typeof dimScores !== 'object') return null;
    const val = dimScores[competencyName];
    return typeof val === 'number' ? val * 10 : null; // scale 0-10 -> 0-100, same as the rollup
  }
  if (engineType === 'drill') {
    const breakdown = raw.rubric_breakdown;
    if (!Array.isArray(breakdown)) return null;
    const entry = breakdown.find((e) => e && e.dimension === competencyName && typeof e.score === 'number');
    return entry ? entry.score : null;
  }
  return null;
}

/**
 * not_started — students enrolled in the cohort who never started ANY of the
 * cohort's currently-released assessments (funnel assigned-vs-started delta:
 * assigned = whole active enrollment, since a released assessment targets
 * the whole cohort; started = distinct userIds with an AssessmentSession row
 * against one of those released assessments). No released assessment ->
 * nothing is "assigned" yet -> cluster does not fire (returns null).
 */
async function computeNotStartedCluster({ institutionId, cohortId }, deps) {
  const releasedAssessments = await deps.Assessment.find({ institutionId, cohortId, status: 'released' });
  if (!releasedAssessments || !releasedAssessments.length) return null;
  const releasedIds = releasedAssessments.map((a) => String(a._id));

  const enrolled = await deps.InstitutionEnrollment.find({
    institutionId, cohortId, status: { $ne: 'withdrawn' }, userId: { $exists: true },
  });
  const enrolledStudentIds = (enrolled || []).filter((e) => e.userId).map((e) => String(e.userId));
  if (!enrolledStudentIds.length) return null;

  const sessions = await deps.AssessmentSession.find({
    institutionId, cohortId, assessmentId: { $in: releasedIds },
  });
  const startedStudentIds = new Set((sessions || []).map((s) => String(s.userId)));

  const notStarted = enrolledStudentIds.filter((id) => !startedStudentIds.has(id));
  if (!notStarted.length) return null;

  const single = releasedAssessments.length === 1;
  return {
    key: 'not_started',
    label: 'Not started',
    studentIds: notStarted,
    evidence: {
      releasedAssessmentCount: releasedAssessments.length,
      releasedAssessmentTitles: releasedAssessments.map((a) => a.title),
      assignedCount: enrolledStudentIds.length,
      notStartedCount: notStarted.length,
    },
    proposedAction: {
      kind: 'notify_students',
      payload: {
        title: single ? 'Your assessment is still open — start now' : 'Assessments still open — start now',
        message: `${releasedAssessments.length} assessment${single ? '' : 's'} released for your cohort ${single ? 'is' : 'are'} still open, and our records show you haven't started ${single ? 'it' : 'any of them'} yet. Start before the window closes so you don't miss out on results and feedback.`,
      },
    },
  };
}

/**
 * weak_competency — students whose graded sessions score below
 * WEAK_COMPETENCY_THRESHOLD on the cohort's single weakest competency (the
 * lowest-avgScore entry on the latest cohort-wide rollup's byCompetency).
 * No cohort-wide rollup, or an empty byCompetency array -> cluster does not
 * fire.
 */
async function computeWeakCompetencyCluster({ institutionId, cohortId }, deps) {
  const rollup = await deps.CohortRollup.findOne({ institutionId, cohortId, assessmentId: null });
  const byCompetency = (rollup && rollup.byCompetency) || [];
  if (!byCompetency.length) return null;

  const weakest = byCompetency.reduce(
    (min, c) => (typeof c.avgScore === 'number' && (min == null || c.avgScore < min.avgScore) ? c : min),
    null,
  );
  if (!weakest || typeof weakest.avgScore !== 'number') return null;

  const gradedSessions = await deps.AssessmentSession.find({ institutionId, cohortId, status: 'graded' });
  const worstByStudent = new Map();
  for (const session of gradedSessions || []) {
    const score = extractCompetencyScore(session, weakest.name);
    if (typeof score !== 'number') continue;
    if (score < WEAK_COMPETENCY_THRESHOLD) {
      const key = String(session.userId);
      const existing = worstByStudent.get(key);
      if (existing === undefined || score < existing) worstByStudent.set(key, score);
    }
  }
  if (!worstByStudent.size) return null;

  const studentIds = [...worstByStudent.keys()];
  return {
    key: 'weak_competency',
    label: `Weak in ${weakest.name}`,
    studentIds,
    evidence: {
      competencyName: weakest.name,
      cohortAvgScore: weakest.avgScore,
      threshold: WEAK_COMPETENCY_THRESHOLD,
      studentsBelowThreshold: studentIds.length,
    },
    proposedAction: {
      kind: 'notify_students',
      payload: {
        title: `Extra practice recommended: ${weakest.name}`,
        message: `Your recent graded assessments show ${weakest.name} scoring below ${WEAK_COMPETENCY_THRESHOLD}%, the weakest competency for your cohort right now (cohort average ${weakest.avgScore}%). A short, focused practice session here could meaningfully improve your next assessment.`,
      },
    },
  };
}

/**
 * inactive — students enrolled for at least INACTIVE_WINDOW_DAYS with zero
 * AssessmentSession activity ever (see the constant's doc comment for why
 * "ever" is the only honest reading of "zero activity in the window").
 */
async function computeInactiveCluster({ institutionId, cohortId }, deps, now) {
  const cutoff = new Date(now.getTime() - INACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const enrolled = await deps.InstitutionEnrollment.find({
    institutionId, cohortId, status: { $ne: 'withdrawn' }, userId: { $exists: true },
  });
  const eligible = (enrolled || []).filter((e) => e.userId && e.createdAt && new Date(e.createdAt) <= cutoff);
  if (!eligible.length) return null;

  const allSessions = await deps.AssessmentSession.find({ institutionId, cohortId });
  const everStarted = new Set((allSessions || []).map((s) => String(s.userId)));

  const inactiveStudentIds = eligible.filter((e) => !everStarted.has(String(e.userId))).map((e) => String(e.userId));
  if (!inactiveStudentIds.length) return null;

  return {
    key: 'inactive',
    label: 'Inactive',
    studentIds: inactiveStudentIds,
    evidence: {
      windowDays: INACTIVE_WINDOW_DAYS,
      cutoffAt: cutoff,
      inactiveCount: inactiveStudentIds.length,
    },
    proposedAction: {
      kind: 'notify_students',
      payload: {
        title: "We haven't seen you in a while",
        message: `You're enrolled but haven't started any assessment in the last ${INACTIVE_WINDOW_DAYS} days. Log in and get started — even one attempt puts you back on track.`,
      },
    },
  };
}

/**
 * buildCohortBrief({ institutionId, cohortId }, deps) -> Promise<{ clusters, proposedActions } | null>
 *
 * Computes all three clusters in parallel; returns null when none of them
 * fire (nothing actionable this week for this cohort).
 */
async function buildCohortBrief({ institutionId, cohortId }, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  const now = (d.now && d.now()) || new Date();

  const [notStarted, weakCompetency, inactive] = await Promise.all([
    computeNotStartedCluster({ institutionId, cohortId }, d),
    computeWeakCompetencyCluster({ institutionId, cohortId }, d),
    computeInactiveCluster({ institutionId, cohortId }, d, now),
  ]);

  const clusters = [notStarted, weakCompetency, inactive].filter(Boolean);
  if (!clusters.length) return null;

  const proposedActions = clusters.map((c) => ({
    clusterKey: c.key,
    kind: c.proposedAction.kind,
    payload: c.proposedAction.payload,
  }));

  return { clusters, proposedActions };
}

/**
 * Every institution cohort with a rollup or active (non-withdrawn) enrollment
 * — the candidate population runWeekly iterates. De-duplicated union of both
 * sources: a cohort can have active enrollment before its first rollup ever
 * computes, and (rarely) a stale rollup after every enrollment is withdrawn.
 */
async function listCandidateCohorts(deps) {
  const enrollmentPairs = await deps.InstitutionEnrollment.aggregate([
    { $match: { status: { $ne: 'withdrawn' } } },
    { $group: { _id: { institutionId: '$institutionId', cohortId: '$cohortId' } } },
  ]);
  const rollupPairs = await deps.CohortRollup.aggregate([
    { $group: { _id: { institutionId: '$institutionId', cohortId: '$cohortId' } } },
  ]);

  const seen = new Map();
  for (const p of [...(enrollmentPairs || []), ...(rollupPairs || [])]) {
    const institutionId = p._id.institutionId;
    const cohortId = p._id.cohortId;
    const key = `${institutionId}:${cohortId}`;
    if (!seen.has(key)) seen.set(key, { institutionId, cohortId });
  }
  return [...seen.values()];
}

/**
 * runWeekly(deps) -> Promise<{ briefs: n }>
 *
 * Flag-gated (zero DB reads when off). For every candidate cohort, builds a
 * brief; when non-null, records ONE AgentDecision 'brief' row. Per-cohort
 * try/catch — one cohort's failure never blocks the rest of the run.
 */
async function runWeekly(deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  if (!d.isAgentEnabled('intervention')) return { briefs: 0 };

  const cohorts = await d.listCandidateCohorts(d);

  let briefs = 0;
  for (const { institutionId, cohortId } of cohorts) {
    try {
      const brief = await buildCohortBrief({ institutionId, cohortId }, d);
      if (!brief) continue;

      let cohortLabel = String(cohortId);
      try {
        const cohort = await d.InstitutionCohort.findById(cohortId);
        if (cohort && cohort.label) cohortLabel = cohort.label;
      } catch (_) {
        // best-effort label lookup — never blocks recording the brief
      }

      await d.record({
        agentId: 'intervention',
        decisionType: 'brief',
        institutionId,
        cohortId,
        action: {
          kind: 'cohort_intervention_brief',
          clusters: brief.clusters,
          proposedActions: brief.proposedActions,
          cohortLabel,
        },
        promptVersion: 'intervention-v1',
      }, d);
      briefs += 1;
    } catch (err) {
      console.warn('[interventionAgent] cohort brief failed', institutionId, cohortId, err && err.message);
    }
  }

  return { briefs };
}

module.exports = {
  buildCohortBrief,
  runWeekly,
  _helpers: {
    extractCompetencyScore,
    computeNotStartedCluster,
    computeWeakCompetencyCluster,
    computeInactiveCluster,
    listCandidateCohorts,
    WEAK_COMPETENCY_THRESHOLD,
    INACTIVE_WINDOW_DAYS,
  },
};
