'use strict';

/**
 * proofJourneyService — the proof-builder agent (#8, flag `proof_builder`).
 *
 * JD paste → skill extraction → capstone generation (existing engine) →
 * grade (existing engine, hooked in Task 4) → publish (existing
 * proofService) — one small state machine stitching engines that already
 * exist. The ONLY LLM call in this service is the JD skill extraction; every
 * other transition is deterministic.
 *
 * Every function is flag-gated on `proof_builder` and takes an optional
 * `deps` for test injection (repo convention: zero network/DB in tests),
 * mirroring interviewProgramService.
 */

const STEP_DEFS = [
  { key: 'extract', label: 'Reading your job description' },
  { key: 'generate', label: 'Generating your capstone' },
  { key: 'build', label: 'Building & validating your capstone' },
  { key: 'grade', label: 'Grading your submission' },
  { key: 'publish', label: 'Publishing your proof' },
];

// Default language per role-track (shared constant — see langByTrack.js).
// A JD-driven proof capstone uses the learner's track default rather than
// sniffing the JD text for a language hint (the existing JD-paste flow does
// that sniff on the raw job_description field itself;
// capstoneAuthoringSupport.requestGeneration forwards our jdText as
// job_description, so the generator still benefits from the JD content even
// though we don't duplicate the sniff here).
const { LANG_BY_TRACK } = require('../coding/services/langByTrack');

// Proof-journey capstones default to medium difficulty — this is a "prove a
// skill for a real JD" artifact, not a recalibrated practice rep, so we don't
// pull the learner's DifficultyState the way the D2C generate-capstone screen
// does. Documented, deliberate simplification for this agent.
const DEFAULT_DIFFICULTY = 'medium';

const EXTRACTION_SYSTEM_PROMPT = `You extract a compact structured summary from a pasted job description for an
internal "prove this skill" pipeline. Return STRICT JSON only, no prose, no
markdown fences: { "role": string, "company": string, "skills": string[] }.
"role" is the job title (best guess if not explicit, e.g. "Backend Engineer").
"company" is the hiring company name, or "" if not stated/unclear — never
invent one. "skills" is at most 6 short (1-3 word) concrete technical skills
or tools this JD emphasizes (e.g. "React", "system design", "SQL
optimization") — most important first. No duplicates, no soft skills.`;

/**
 * Per-key `deps.X || require(...)` (NOT `{...defaultDeps(), ...deps}`) —
 * short-circuit evaluation means an overridden dep's require() never runs at
 * all. This matters here specifically because `../config/aiProvider` throws
 * at require-time when OPENAI_API_KEY isn't set (real in CI/test envs); the
 * naive "build the full defaults object, then spread test overrides on top"
 * pattern (used elsewhere, e.g. interviewProgramService) would eagerly
 * require it even when every test supplies a fake aiProvider.
 */
function buildDeps(deps = {}) {
  return {
    ProofJourney: deps.ProofJourney || require('../models/ProofJourney'),
    AgentDecision: deps.AgentDecision || require('../models/AgentDecision'),
    UserObjective: deps.UserObjective || require('../models/UserObjective'),
    // Correlation-closure deps (Task 4 EXPANDED): advanceOnCapstoneGraded
    // resolves sessionId -> bundle_id via CapstoneSession, and (fallback)
    // bundle_id -> the originating CapstoneGenerationRequest.
    CapstoneSession: deps.CapstoneSession || require('../coding/models/capstoneSession.model'),
    CapstoneGenerationRequest:
      deps.CapstoneGenerationRequest || require('../coding/models/capstoneGenerationRequest.model'),
    codingEligibility: deps.codingEligibility || require('../coding/services/codingEligibility'),
    requestGeneration: deps.requestGeneration || require('../coding/services/capstoneAuthoringSupport').requestGeneration,
    aiProvider: deps.aiProvider || require('../config/aiProvider'),
    proofService: deps.proofService || require('./readiness/proofService'),
    record: deps.record || require('./agentDecisionService').record,
    isAgentEnabled: deps.isAgentEnabled || require('../config/agentFlags').isAgentEnabled,
    now: deps.now || (() => new Date()),
    // No eager default for resolveRoleTrackForUser — kickCapstoneGeneration
    // falls back to defaultResolveRoleTrackForUser itself when this is unset.
    resolveRoleTrackForUser: deps.resolveRoleTrackForUser,
    _awaitBackground: deps._awaitBackground,
  };
}

function seedSteps() {
  const now = new Date();
  return STEP_DEFS.map((s, i) => ({
    key: s.key,
    label: s.label,
    status: i === 0 ? 'now' : 'todo',
    at: i === 0 ? now : undefined,
  }));
}

function setStep(journey, key, status, at) {
  const step = (journey.steps || []).find((s) => s.key === key);
  if (!step) return;
  step.status = status;
  step.at = at || new Date();
}

/**
 * startJourney({ userId, jdText }, deps) -> Promise<ProofJourney|null>
 *
 * Creates the journey row + records the 'proof_journey' ledger row
 * synchronously (so the caller always gets a row with a real _id back),
 * then runs skill extraction + capstone-generation kickoff as an internal
 * fire-and-forget background step (see runExtractionAndGeneration) — the
 * caller is never blocked on the LLM call or the generation-enqueue DB
 * round-trip, and a crash in that background step NEVER throws back to the
 * caller (it's caught and persisted as journey.status='failed' instead).
 *
 * Basic input validation (missing jdText) throws synchronously — that's a
 * caller bug, not a "hook safety" concern, so it's fine for it to reject.
 *
 * Flag off -> null, zero writes.
 */
async function startJourney({ userId, jdText }, deps = {}) {
  const d = buildDeps(deps);
  if (!d.isAgentEnabled('proof_builder')) return null;

  const trimmed = String(jdText || '').trim();
  if (!trimmed) throw new Error('jdText is required');
  const clipped = trimmed.slice(0, 20000);

  const journey = await d.ProofJourney.create({
    userId,
    jdText: clipped,
    status: 'extracting',
    steps: seedSteps(),
    jdSummary: {},
    capstoneRef: {},
  });

  try {
    const row = await d.record({
      agentId: 'proof_builder',
      decisionType: 'artifact',
      userId,
      action: { kind: 'proof_journey', jdChars: clipped.length },
      promptVersion: 'proof-builder-v1',
    }, d);
    if (row && row._id) {
      journey.ledgerDecisionId = row._id;
      await journey.save();
    }
  } catch (err) {
    console.warn('[proofJourneyService] proof_journey ledger record failed:', err.message);
  }

  // Fire-and-forget: never awaited by the caller in production. `d._awaitBackground`
  // is a test-only seam (default deps never set it) so the ~10 colocated tests can
  // assert on the post-extraction/post-generation state deterministically instead
  // of racing a background microtask.
  const background = runExtractionAndGeneration(journey, clipped, userId, d).catch((err) => {
    console.warn('[proofJourneyService] background extract/generate crashed:', err.message);
  });
  if (d._awaitBackground) await background;

  return journey;
}

/**
 * Background step run (not awaited) by startJourney. Never throws — every
 * failure path persists status='failed' + the relevant step='failed' on the
 * journey itself; the outer .catch in startJourney is a last-resort net for
 * a truly unexpected crash (e.g. journey.save() itself failing).
 */
async function runExtractionAndGeneration(journey, jdText, userId, d) {
  let extracted;
  try {
    extracted = await extractJdSkills(jdText, d);
  } catch (err) {
    journey.status = 'failed';
    setStep(journey, 'extract', 'failed');
    await journey.save();
    return;
  }

  journey.jdSummary = extracted;
  journey.status = 'capstone_pending';
  setStep(journey, 'extract', 'done');
  setStep(journey, 'generate', 'now');
  await journey.save();

  let genReq;
  try {
    genReq = await kickCapstoneGeneration({ userId, jdText }, d);
  } catch (err) {
    journey.status = 'failed';
    setStep(journey, 'generate', 'failed');
    await journey.save();
    return;
  }

  // capstoneRef.bundleId/sessionId aren't known yet at kickoff time — the
  // generation request still has to run (generate -> validate -> cross-check
  // -> ready) and then the learner has to start an attempt on the resulting
  // bundle before a CapstoneSession (and therefore a sessionId) exists.
  // capstoneRef.generationRequestId IS known right now though (genReq._id) —
  // persist it so advanceOnCapstoneGraded's correlation-closure fallback
  // (Task 4 EXPANDED) can resolve this journey the first time its capstone
  // is graded, before bundleId/sessionId are ever stamped. This journey
  // enters 'building' to reflect "capstone is in flight"; the next
  // observable transition is advanceOnCapstoneGraded, once the underlying
  // session is graded.
  journey.status = 'building';
  setStep(journey, 'generate', 'done');
  setStep(journey, 'build', 'now');
  journey.capstoneRef = journey.capstoneRef || {};
  journey.capstoneRef.generationRequestId = genReq && genReq._id;
  await journey.save();
  return genReq;
}

/**
 * ONE aiProvider call: strict JSON { role, company, skills[] }, clamped to
 * <=6 skills. `aiProvider.analyzeWithClaude` already throws on non-JSON by
 * default (lenient=false) — that's exactly the "strict JSON discipline" this
 * step relies on; we don't add a second parse layer on top.
 */
async function extractJdSkills(jdText, d) {
  const raw = await d.aiProvider.analyzeWithClaude({
    systemPrompt: EXTRACTION_SYSTEM_PROMPT,
    userPrompt: `Job description:\n\n${jdText}`,
    temperature: 0.2,
    maxTokens: 500,
  });
  const role = typeof raw.role === 'string' ? raw.role.trim().slice(0, 200) : '';
  const company = typeof raw.company === 'string' ? raw.company.trim().slice(0, 200) : '';
  const skills = Array.isArray(raw.skills)
    ? raw.skills.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().slice(0, 80)).slice(0, 6)
    : [];
  return { role, company, skills };
}

async function defaultResolveRoleTrackForUser(userId, d) {
  const obj = await d.UserObjective.findOne({ userId, status: 'active', isPrimary: true }).lean();
  const eligibility = d.codingEligibility.evaluateCodingEligibility(obj);
  return eligibility.eligible ? eligibility.role_track : null;
}

/**
 * Kicks capstone generation via the EXACT SAME entry point the mobile
 * JD-paste generator uses (capstoneAuthoringSupport.requestGeneration) — it
 * creates the CapstoneGenerationRequest doc and enqueues the same
 * `capstone-generation` BullMQ job the D2C /capstones/generate route
 * enqueues. No parallel generation path.
 */
async function kickCapstoneGeneration({ userId, jdText }, d) {
  const resolveRoleTrackForUser = d.resolveRoleTrackForUser || defaultResolveRoleTrackForUser;
  const roleTrack = await resolveRoleTrackForUser(userId, d);
  if (!roleTrack) throw new Error('no resolvable coding track for JD-driven capstone generation');
  const language = LANG_BY_TRACK[roleTrack] || 'python';
  return d.requestGeneration({
    userId,
    roleTrack,
    difficulty: DEFAULT_DIFFICULTY,
    language,
    jobDescription: jdText,
    topicHint: '',
  });
}

/**
 * Deterministic next-proof heuristic (documented per the plan's requirement):
 *
 *   1. Take jdSummary.skills (already <=6, most-important-first from
 *      extraction).
 *   2. Load the learner's readiness snapshot (proofService.buildSnapshot) —
 *      its `competencies` array is the evidence surface: named, assessed
 *      competencies backed by real quiz/interview/capstone data.
 *   3. A JD skill counts as "evidenced" if it fuzzy-matches (case-insensitive
 *      substring, either direction) any assessed competency name.
 *   4. Suggestion = the FIRST JD skill (priority order preserved) that is
 *      NOT evidenced — that's the clearest gap between what this JD wants
 *      and what the learner has actually proven.
 *   5. If every JD skill is already evidenced, fall back to the weakest
 *      (lowest-score) evidenced competency that overlaps the JD skill list —
 *      still worth reinforcing rather than nothing.
 *   6. If the learner has no readiness snapshot yet (no active objective /
 *      no snapshot — proofService throws NO_OBJECTIVE/NO_SNAPSHOT), or no
 *      overlap exists, fall back to the first JD skill with an honest reason.
 *
 * Never throws — a missing snapshot is a normal "brand new learner" case,
 * not an error.
 */
async function computeNextProofSuggestion({ userId, jdSummary }, d) {
  const skills = (jdSummary && Array.isArray(jdSummary.skills)) ? jdSummary.skills : [];
  if (!skills.length) return null;

  let snapshot = null;
  try {
    snapshot = await d.proofService.buildSnapshot(userId);
  } catch (err) {
    return {
      skill: skills[0],
      reason: `No readiness evidence yet — ${skills[0]} is the first skill from this JD worth proving.`,
    };
  }

  const competencies = (snapshot && snapshot.competencies) || [];
  const fuzzyOverlap = (skill, name) => {
    const s = skill.toLowerCase();
    const n = String(name || '').toLowerCase();
    return !!n && (n.includes(s) || s.includes(n));
  };
  const isEvidenced = (skill) => competencies.some((c) => fuzzyOverlap(skill, c.name));

  const gap = skills.find((s) => !isEvidenced(s));
  if (gap) {
    return {
      skill: gap,
      reason: `${gap} appears in this JD but isn't evidenced in your readiness competencies yet — a strong next proof.`,
    };
  }

  const overlapping = competencies
    .filter((c) => skills.some((s) => fuzzyOverlap(s, c.name)))
    .sort((a, b) => (a.score || 0) - (b.score || 0));
  if (overlapping.length) {
    const weakest = overlapping[0];
    return {
      skill: weakest.name,
      reason: `All JD skills are already evidenced — ${weakest.name} is your weakest score (${weakest.score}) among them, worth reinforcing.`,
    };
  }

  return {
    skill: skills[0],
    reason: `All listed JD skills are already evidenced — ${skills[0]} is still a good one to keep proving as you go deeper.`,
  };
}

/**
 * advanceOnCapstoneGraded({ userId, sessionId }, deps) -> Promise<{advanced:boolean, journey?}>
 *
 * Hook target (Task 4, EXPANDED correlation closure): fire-and-forget after
 * a CapstoneSession's grade persists. Task 3 left capstoneRef.bundleId/
 * sessionId UNSET at kickoff time (see runExtractionAndGeneration) — a
 * straight `capstoneRef.sessionId` match would therefore NEVER fire, which
 * is the bug this rewrite closes. Resolution chain:
 *
 *   1. Load the CapstoneSession by sessionId -> its bundle_id (the model's
 *      real field name — src/coding/models/capstoneSession.model.js).
 *   2. Direct match: this user's journey with capstoneRef.bundleId ===
 *      bundle_id (covers a journey a PRIOR grade already correlated).
 *   3. Fallback (bundleId not yet stamped on any journey): resolve the
 *      CapstoneGenerationRequest that produced this bundle
 *      (bundle_id === session's bundle_id) and match this user's journey by
 *      capstoneRef.generationRequestId === that request's _id — stamped in
 *      runExtractionAndGeneration when generation was kicked off, so this is
 *      the path that fires on a journey's FIRST grade.
 *   4. On match: stamp capstoneRef.bundleId + capstoneRef.sessionId onto the
 *      journey (closing the correlation for any future direct-bundleId
 *      lookup — e.g. a retry/regrade of the same bundle), then advance
 *      exactly as before (steps, status -> publishable, nextProofSuggestion,
 *      ledger outcomeSignal).
 *   5. No match anywhere (session not found, no bundle_id, no journey via
 *      either path, or wrong userId) -> {advanced:false}, silent no-op —
 *      never a throw, so this hook can never break the capstone-eval
 *      worker's critical path.
 *
 * Idempotent: a journey already 'publishable' or 'published' is left alone
 * (no re-computation, no duplicate ledger mutation) — the hook may fire more
 * than once for the same session in production (retries, races).
 *
 * Flag off -> {advanced:false}, zero writes.
 */
async function advanceOnCapstoneGraded({ userId, sessionId }, deps = {}) {
  const d = buildDeps(deps);
  if (!d.isAgentEnabled('proof_builder')) return { advanced: false };

  const session = await d.CapstoneSession.findById(sessionId).lean();
  const bundleId = session && session.bundle_id;
  if (!bundleId) return { advanced: false };

  let journey = await d.ProofJourney.findOne({ userId, 'capstoneRef.bundleId': bundleId });

  if (!journey) {
    const genReq = await d.CapstoneGenerationRequest.findOne({ bundle_id: bundleId }).lean();
    if (genReq) {
      journey = await d.ProofJourney.findOne({ userId, 'capstoneRef.generationRequestId': genReq._id });
    }
  }

  if (!journey) return { advanced: false };
  if (journey.status === 'publishable' || journey.status === 'published') return { advanced: false };

  journey.capstoneRef = journey.capstoneRef || {};
  journey.capstoneRef.bundleId = bundleId;
  journey.capstoneRef.sessionId = sessionId;

  const suggestion = await computeNextProofSuggestion({ userId, jdSummary: journey.jdSummary }, d);

  journey.status = 'publishable';
  setStep(journey, 'build', 'done');
  setStep(journey, 'grade', 'done');
  setStep(journey, 'publish', 'now');
  journey.nextProofSuggestion = suggestion || null;
  await journey.save();

  if (journey.ledgerDecisionId) {
    try {
      const row = await d.AgentDecision.findById(journey.ledgerDecisionId);
      if (row) {
        row.outcomeSignal = { ...(row.outcomeSignal || {}), graded: true };
        row.markModified('outcomeSignal');
        await row.save();
      }
    } catch (err) {
      console.warn('[proofJourneyService] outcomeSignal ledger update failed:', err.message);
    }
  }

  return { advanced: true, journey };
}

/**
 * publishProof({ userId }, deps) -> Promise<ProofJourney>
 *
 * Guards status 'publishable' (same "guard throws" convention as
 * interviewProgramService.createProgram's one-active guard) — the route
 * layer (Task 4) maps the guard message to 404/409 via message-regex, house
 * style. On success: calls the existing proofService.publish(userId),
 * stores the returned token, flips status to 'published', marks the
 * 'publish' step done, and closes the ledger row opened in startJourney as
 * 'accepted' (the student publishing IS the acceptance signal for this
 * agent — there is no separate human-review step).
 *
 * Flag off -> null, zero writes.
 */
async function publishProof({ userId }, deps = {}) {
  const d = buildDeps(deps);
  if (!d.isAgentEnabled('proof_builder')) return null;

  const journey = await d.ProofJourney.findOne({ userId }).sort({ createdAt: -1 });
  if (!journey) throw new Error('no proof journey found');
  if (journey.status !== 'publishable') throw new Error('proof journey is not publishable yet');

  const published = await d.proofService.publish(userId);

  journey.proofToken = published.token;
  journey.status = 'published';
  setStep(journey, 'publish', 'done');
  await journey.save();

  if (journey.ledgerDecisionId) {
    try {
      const row = await d.AgentDecision.findById(journey.ledgerDecisionId);
      if (row) {
        row.status = 'accepted';
        row.respondedAt = d.now ? d.now() : new Date();
        await row.save();
      }
    } catch (err) {
      console.warn('[proofJourneyService] ledger accept-close failed:', err.message);
    }
  }

  return journey;
}

/**
 * getJourney({ userId }, deps) -> Promise<object|null>
 *
 * Read-only client shape for the learner's latest journey: steps checklist
 * exactly like the approved mockup, plus jdSummary/capstoneRef/proofToken/
 * nextProofSuggestion. Zero writes.
 *
 * Flag off -> null. No journey yet -> null.
 */
async function getJourney({ userId }, deps = {}) {
  const d = buildDeps(deps);
  if (!d.isAgentEnabled('proof_builder')) return null;

  const journey = await d.ProofJourney.findOne({ userId }).sort({ createdAt: -1 }).lean();
  if (!journey) return null;

  return {
    _id: journey._id,
    status: journey.status,
    jdSummary: journey.jdSummary || { role: '', company: '', skills: [] },
    steps: journey.steps || [],
    capstoneRef: journey.capstoneRef || { bundleId: null, sessionId: null },
    proofToken: journey.proofToken || null,
    nextProofSuggestion: journey.nextProofSuggestion || null,
    createdAt: journey.createdAt,
  };
}

module.exports = {
  startJourney,
  advanceOnCapstoneGraded,
  publishProof,
  getJourney,
  _helpers: {
    STEP_DEFS,
    LANG_BY_TRACK,
    DEFAULT_DIFFICULTY,
    seedSteps,
    setStep,
    extractJdSkills,
    kickCapstoneGeneration,
    computeNextProofSuggestion,
    runExtractionAndGeneration,
  },
};
