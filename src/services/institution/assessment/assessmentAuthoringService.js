'use strict';
/**
 * Assessment Authoring Service
 *
 * Generates questions for MCQ assessments via quizGenerationService and
 * freezes them onto the Assessment document so the release gate can check
 * that questions exist before publishing to students.
 *
 * NOTE — generateQuiz KnowledgeProfile tolerance:
 *   quizGenerationService.generateQuiz calls KnowledgeProfile.findOne({ userId }).
 *   When the userId (assessment.createdBy, an InstitutionUser id) has no
 *   KnowledgeProfile, findOne returns null and the service gracefully falls back
 *   to level='beginner', targetDifficulty='medium' (lines 148-149 of
 *   quizGenerationService.js). The result is a standard beginner-mix quiz — no
 *   crash. Safe to call with any userId.
 *   Similarly, UserObjective.findOne returns null → competencyContext stays null
 *   (lines 189-234), userContextService failures are caught and swallowed
 *   (lines 327-347), and ExternalContentTouch failures are caught too
 *   (lines 353-371). The only hard failure path is the OpenAI call itself, which
 *   is expected to throw on network/API error — that bubble is intentional.
 *
 * NOTE — zero D2C side-effects from the throwaway quiz:
 *   The only persistent write generateQuiz makes here is the Quiz doc itself
 *   (which we delete immediately after freezing its questions). Its other
 *   side-effects are gated OFF by the args we pass: the QuizTrigger write is
 *   gated on `triggerId` (we pass none) and the push notification is gated on
 *   `suppressNotification` (we pass true). Crucially, Quiz.userId is set to an
 *   InstitutionUser id; every D2C Quiz reader scopes by the authenticated
 *   User id, and the two id-spaces never collide — so the transient quiz is
 *   invisible to all D2C surfaces even before it is deleted.
 *
 * NOTE — sourceId grounding (2A feature):
 *   When cfg.sourceId is set on a mcq/capstone/interview assessment, the
 *   authoring service loads the AssessmentSource and uses its extractedText /
 *   extractedTopics to ground question generation. This is entirely additive —
 *   when sourceId is absent the service behaves identically to before.
 */

const SOURCE_TEXT_LIMIT_CAPSTONE = 2000;
const MCQ_GROUNDING_LIMIT = 6000; // chars of syllabus text injected into generation
const MCQ_OVER_GENERATION_FACTOR = 1.5; // over-generate the servable pool
const MCQ_MAX_ROUNDS = 3; // initial generation + 2 regeneration rounds
const MCQ_SYLLABUS_EXCERPT_LIMIT = 2000; // judge context
const { LANG_BY_TRACK } = require('../../../coding/services/langByTrack');

function getModel(deps) { return (deps && deps.Assessment) || require('../../../models/Assessment'); }
function getQuiz(deps) { return (deps && deps.Quiz) || require('../../../models/Quiz'); }
function getContent(deps) { return (deps && deps.Content) || require('../../../models/Content'); }
function getQuizGenerationService(deps) {
  return (deps && deps.quizGenerationService) || require('../../quizGenerationService');
}
function getAssessmentSource(deps) {
  return (deps && deps.AssessmentSource) || require('../../../models/AssessmentSource');
}
function getQuestionQaService(deps) {
  return (deps && deps.questionQaService) || require('./questionQaService');
}

/**
 * Build grounding text from a ready AssessmentSource: extractedText chunked to
 * `limit` chars, preferring paragraphs that mention the extracted topics.
 */
function buildGroundingText(source, limit = MCQ_GROUNDING_LIMIT) {
  const text = (source && source.extractedText) || '';
  if (!text) return '';
  if (text.length <= limit) return text;
  const topics = ((source && source.extractedTopics) || []).map((t) => t && t.name).filter(Boolean);
  if (topics.length === 0) return text.slice(0, limit);
  const paras = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  const scored = paras.map((p, i) => {
    const low = p.toLowerCase();
    const score = topics.reduce((s, t) => s + (low.includes(String(t).toLowerCase()) ? 1 : 0), 0);
    return { p, i, score };
  });
  // Most-relevant-first, stable on original order for ties.
  scored.sort((a, b) => (b.score - a.score) || (a.i - b.i));
  let out = '';
  for (const { p } of scored) {
    if (out.length + p.length + 2 > limit) continue;
    out += (out ? '\n\n' : '') + p;
  }
  return out || text.slice(0, limit);
}

/** Fold a per-round QA report into a cumulative authoring summary. */
function accumulateReport(acc, report) {
  const a = acc || { rounds: 0, totalGenerated: 0, totalPassed: 0, totalRejected: 0, rejectionReasons: {}, letterDistribution: null };
  a.rounds += 1;
  a.totalGenerated += report.total || 0;
  a.totalPassed += report.passedCount || 0;
  a.totalRejected += report.rejectedCount || 0;
  a.letterDistribution = report.letterDistribution || a.letterDistribution;
  for (const r of report.rejections || []) {
    for (const reason of r.reasons || []) {
      a.rejectionReasons[reason] = (a.rejectionReasons[reason] || 0) + 1;
    }
  }
  return a;
}

/**
 * Author (generate) MCQ questions for an assessment.
 *
 * If cfg.sourceId is set and the AssessmentSource is ready:
 *   - Creates a TRANSIENT Content doc (contentType:'notes') with keyConcepts from topics
 *   - Passes its _id as contentIds to generateQuiz → content-grounded MCQ
 *   - Deletes the transient Content after (best-effort)
 * Otherwise behaves as before (topic-based).
 *
 * @param {string|ObjectId} assessmentId
 * @param {object}          deps          - injectable: { Assessment, Quiz, Content,
 *                                            AssessmentSource, quizGenerationService }
 * @returns {Promise<Assessment|null>}    - updated Assessment, or null if not mcq type
 */
async function authorMcq(assessmentId, deps = {}) {
  const Assessment = getModel(deps);
  const assessment = await Assessment.findById(assessmentId);
  if (!assessment) throw new Error('NOT_FOUND');

  // Only MCQ assessments need authored questions
  if (assessment.type !== 'mcq') return null;

  const cfg = assessment.config && assessment.config.mcq ? assessment.config.mcq : {};
  const targetCount = cfg.questionCount || cfg.totalQuestions || 10;
  const poolTarget = Math.max(targetCount, Math.ceil(targetCount * MCQ_OVER_GENERATION_FACTOR));

  // ── Honest status: mark generating up-front so the release gate never lies ──
  assessment.config.mcq.authoring = { status: 'generating', error: null, qaReport: null };
  assessment.markModified('config');
  try { await assessment.save(); } catch (_) { /* best-effort early status */ }

  // ── Grounding: load AssessmentSource when sourceId is configured ────────────
  let transientContentId = null;
  let contentIds = undefined;
  let groundingText = '';
  let syllabusExcerpt = '';

  if (cfg.sourceId) {
    const AssessmentSource = getAssessmentSource(deps);
    const source = await AssessmentSource.findById(cfg.sourceId);
    if (source && source.status === 'ready') {
      // Create a transient Content doc so generateQuiz can inject concepts.
      // importance MUST be a Number (keyConceptSchema: {type:Number,min:1,max:5}).
      const Content = getContent(deps);
      const keyConcepts = (source.extractedTopics || []).map((t) => ({
        concept: t.name,
        description: '',
        importance: 5,
      }));
      const transient = await Content.create({
        title: assessment.title,
        contentType: 'notes',
        domain: 'general',
        contentURL: 'transient',
        ocrText: source.extractedText || '',
        aiData: { keyConcepts },
        status: 'draft',
      });
      transientContentId = transient._id;
      contentIds = [transient._id];
      // Real grounding: chunked syllabus text (most-relevant-first) into generation.
      groundingText = buildGroundingText(source, MCQ_GROUNDING_LIMIT);
      syllabusExcerpt = groundingText.slice(0, MCQ_SYLLABUS_EXCERPT_LIMIT);
    }
  }

  // ── Cohort competencies + topic-domain disambiguation ───────────────────────
  // Placement MCQs pass noObjective, so generateQuiz gets no competency context —
  // a bare topic like "RAG" is ambiguous and the LLM defaults to project status.
  // Pass the cohort ObjectiveTemplate competencies EXPLICITLY (routes generation
  // through the competency prompt so each question emits a `competency` tag), and
  // keep the topic-enrichment string as belt-and-suspenders disambiguation.
  let domainContext = '';
  let competencies = [];
  try {
    const InstitutionCohort = deps.InstitutionCohort || require('../../../models/InstitutionCohort');
    const ObjectiveTemplate = deps.ObjectiveTemplate || require('../../../models/ObjectiveTemplate');
    const cohort = assessment.cohortId ? await InstitutionCohort.findById(assessment.cohortId).select('objectiveTemplateId') : null;
    const tpl = cohort && cohort.objectiveTemplateId
      ? await ObjectiveTemplate.findById(cohort.objectiveTemplateId).select('label objectiveType specifics capabilityTrack competencies')
      : null;
    if (tpl) {
      competencies = (tpl.competencies || [])
        .filter((c) => c && c.name)
        .map((c) => ({ name: c.name, category: c.category, weight: c.weight }));
      const parts = [];
      if (tpl.label) parts.push(tpl.label);
      if (tpl.capabilityTrack) parts.push(`track: ${String(tpl.capabilityTrack).replace(/_/g, ' ')}`);
      if (tpl.specifics && tpl.specifics.targetRole) parts.push(`role: ${tpl.specifics.targetRole}`);
      const comps = competencies.map((c) => c.name).slice(0, 8);
      if (comps.length) parts.push(`competencies: ${comps.join(', ')}`);
      if (parts.length) domainContext = parts.join('; ');
    }
  } catch (e) { console.warn('[authorMcq] domain context lookup failed', e.message); }

  const baseTopic = cfg.topic || assessment.title;
  const enrichedTopic = domainContext
    ? `${baseTopic} — strictly within this technical placement domain: ${domainContext}. Interpret every term/acronym in THIS domain (e.g. "RAG" means Retrieval-Augmented Generation, NOT Red-Amber-Green project status). Do not generate project-management or generic-business questions.`
    : baseTopic;

  const quizGenerationService = getQuizGenerationService(deps);
  const questionQaService = getQuestionQaService(deps);
  const Quiz = getQuiz(deps);

  // ── Over-generate → 3-gate QA → regenerate rejected (max rounds) ────────────
  // Outer try/catch: ANY crash below must persist an honest 'failed' status —
  // never leave the release gate reporting "still generating" forever.
  const passedPool = [];
  let qaAcc = null;
  try {
  try {
    for (let round = 0; round < MCQ_MAX_ROUNDS && passedPool.length < poolTarget; round++) {
      const genCount = Math.max(1, poolTarget - passedPool.length);
      const generateArgs = {
        userId: assessment.createdBy,
        topic: enrichedTopic,
        questionCount: genCount,
        assessmentType: cfg.assessmentType || 'mixed',
        isSkillAssessment: true,
        suppressNotification: true,
        noObjective: true,
      };
      if (contentIds) generateArgs.contentIds = contentIds;
      if (competencies.length) generateArgs.injectedCompetencies = competencies;
      if (groundingText) generateArgs.groundingText = groundingText;

      let quiz;
      try {
        quiz = await quizGenerationService.generateQuiz(generateArgs);
      } catch (genErr) {
        console.warn('[authorMcq] generateQuiz failed on round', round, genErr.message);
        break;
      }

      const generated = (quiz && quiz.questions) || [];
      const { passed, report } = await questionQaService.runQa(
        generated,
        { topic: enrichedTopic, syllabusExcerpt, round },
        { aiProvider: deps.aiProvider }
      );
      qaAcc = accumulateReport(qaAcc, report);
      for (const q of passed) {
        if (passedPool.length >= poolTarget) break;
        passedPool.push(q);
      }

      // Best-effort: delete the throwaway quiz so it never appears in D2C history.
      if (quiz && quiz._id && typeof Quiz.findByIdAndDelete === 'function') {
        try { await Quiz.findByIdAndDelete(quiz._id); } catch (e) {
          console.warn('[assessmentAuthoring] Could not delete throwaway quiz:', e.message);
        }
      }
    }
  } finally {
    // Best-effort: delete the transient Content regardless of success/throw.
    if (transientContentId) {
      const Content = getContent(deps);
      try {
        if (typeof Content.findByIdAndDelete === 'function') {
          await Content.findByIdAndDelete(transientContentId);
        }
      } catch (e) {
        console.warn('[assessmentAuthoring] Could not delete transient Content:', e.message);
      }
    }
  }

  const qaReport = {
    perStudentCount: targetCount,
    poolTarget,
    poolSize: passedPool.length,
    ...(qaAcc || { rounds: 0, totalGenerated: 0, totalPassed: 0, totalRejected: 0, rejectionReasons: {}, letterDistribution: null }),
  };

  if (passedPool.length >= targetCount) {
    // Success — freeze the QA-passed pool; students are sampled from it at serve time.
    // requireUnreleased guards the TOCTOU window: a release landing mid-authoring
    // must never have its live question set swapped underneath students.
    assessment.config.mcq.questions = passedPool;
    assessment.config.mcq.questionCount = targetCount;
    assessment.config.mcq.totalQuestions = targetCount;
    assessment.config.mcq.authoring = { status: 'ready', error: null, qaReport };
    await persistMcqConfig(Assessment, assessment, { requireUnreleased: true });
  } else {
    // Honest failure — never leave questions implying "still generating".
    assessment.config.mcq.authoring = {
      status: 'failed',
      error: `QA produced only ${passedPool.length}/${targetCount} passing questions`,
      qaReport,
    };
    await persistMcqConfig(Assessment, assessment, { requireUnreleased: false });
  }
  } catch (err) {
    if (err && err.message === 'RELEASED') {
      console.warn('[authorMcq] skipped persist — assessment was released mid-authoring');
      throw err;
    }
    try {
      assessment.config.mcq.authoring = {
        status: 'failed',
        error: `authoring crashed: ${err && err.message}`,
        qaReport: qaAcc || null,
      };
      await persistMcqConfig(Assessment, assessment, { requireUnreleased: false });
    } catch (persistErr) {
      console.warn('[authorMcq] could not persist failed status:', persistErr.message);
    }
    throw err;
  }

  return assessment;
}

/**
 * Persist config.mcq atomically. With requireUnreleased, the write is
 * conditional on the assessment not being released/closed (closes the
 * regen/re-author vs release TOCTOU race) — no match ⇒ throws RELEASED.
 * Falls back to doc.save() when the model has no updateOne (test stubs),
 * same defensive-DI convention as Quiz.findByIdAndDelete above.
 */
async function persistMcqConfig(Assessment, assessment, { requireUnreleased }) {
  if (Assessment && typeof Assessment.updateOne === 'function') {
    const filter = { _id: assessment._id };
    if (requireUnreleased) filter.status = { $nin: ['released', 'closed'] };
    const res = await Assessment.updateOne(filter, { $set: { 'config.mcq': assessment.config.mcq } });
    // Mongoose returns matchedCount; legacy drivers n; some stubs only modifiedCount.
    const matched = res ? (res.matchedCount ?? res.n ?? res.modifiedCount ?? 0) : 0;
    if (requireUnreleased && !matched) throw new Error('RELEASED');
    return;
  }
  assessment.markModified('config');
  await assessment.save();
}

/**
 * Regenerate a SINGLE authored MCQ item through the same 3 gates.
 *
 * Generates a small batch, runs QA, and replaces questions[qIndex] with the
 * first passing item. Blocked once the assessment is released (frozen master).
 *
 * @returns {Promise<Assessment>}
 * @throws  Error('NOT_FOUND' | 'NOT_MCQ' | 'RELEASED' | 'BAD_INDEX' | 'REGEN_FAILED')
 */
async function regenerateQuestion(assessmentId, qIndex, deps = {}) {
  const Assessment = getModel(deps);
  const assessment = await Assessment.findById(assessmentId);
  if (!assessment) throw new Error('NOT_FOUND');
  if (assessment.type !== 'mcq') throw new Error('NOT_MCQ');
  if (assessment.status === 'released' || assessment.status === 'closed') throw new Error('RELEASED');

  const cfg = (assessment.config && assessment.config.mcq) || {};
  const questions = Array.isArray(cfg.questions) ? cfg.questions : [];
  const idx = Number(qIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= questions.length) throw new Error('BAD_INDEX');

  const quizGenerationService = getQuizGenerationService(deps);
  const questionQaService = getQuestionQaService(deps);
  const Quiz = getQuiz(deps);

  const baseTopic = cfg.topic || assessment.title;

  let competencies = [];
  try {
    const InstitutionCohort = deps.InstitutionCohort || require('../../../models/InstitutionCohort');
    const ObjectiveTemplate = deps.ObjectiveTemplate || require('../../../models/ObjectiveTemplate');
    const cohort = assessment.cohortId ? await InstitutionCohort.findById(assessment.cohortId).select('objectiveTemplateId') : null;
    const tpl = cohort && cohort.objectiveTemplateId
      ? await ObjectiveTemplate.findById(cohort.objectiveTemplateId).select('competencies')
      : null;
    if (tpl) competencies = (tpl.competencies || []).filter((c) => c && c.name).map((c) => ({ name: c.name, category: c.category, weight: c.weight }));
  } catch (_) { /* best-effort */ }

  const BATCH = 3;
  let replacement = null;
  for (let round = 0; round < MCQ_MAX_ROUNDS && !replacement; round++) {
    const generateArgs = {
      userId: assessment.createdBy,
      topic: baseTopic,
      questionCount: BATCH,
      assessmentType: cfg.assessmentType || 'mixed',
      isSkillAssessment: true,
      suppressNotification: true,
      noObjective: true,
    };
    if (competencies.length) generateArgs.injectedCompetencies = competencies;

    let quiz;
    try {
      quiz = await quizGenerationService.generateQuiz(generateArgs);
    } catch (genErr) {
      console.warn('[regenerateQuestion] generateQuiz failed:', genErr.message);
      break;
    }
    const generated = (quiz && quiz.questions) || [];
    const { passed } = await questionQaService.runQa(
      generated,
      { topic: baseTopic, round },
      { aiProvider: deps.aiProvider }
    );
    if (passed.length > 0) replacement = passed[0];

    if (quiz && quiz._id && typeof Quiz.findByIdAndDelete === 'function') {
      try { await Quiz.findByIdAndDelete(quiz._id); } catch (_) { /* best-effort */ }
    }
  }

  if (!replacement) throw new Error('REGEN_FAILED');

  questions[idx] = replacement;
  assessment.config.mcq.questions = questions;
  // Atomic + conditional: a release landing between the status check above and
  // this write must win — the swap is rejected (throws RELEASED).
  await persistMcqConfig(Assessment, assessment, { requireUnreleased: true });
  return assessment;
}

/**
 * Author (plan) the interview question set for an assessment (Wave 2 block 4).
 *
 * Mirrors the authorMcq honest-status pattern: generate the planned question
 * set + expected-answer outlines, run set-level lint + LLM-as-judge (reject ⇒
 * regenerate once), persist config.interview.authoring = { status, error,
 * questionPlan }. The release gate honours the status; the outlines double as
 * grading anchors (threaded via engineAdapters → InterviewSession.expectedAnswers).
 *
 * @param {string|ObjectId} assessmentId
 * @param {object}          deps - injectable: { Assessment, AssessmentSource,
 *                                   interviewPlanService, aiProvider }
 * @returns {Promise<Assessment|null>} null if not interview type
 */
async function authorInterview(assessmentId, deps = {}) {
  const Assessment = getModel(deps);
  const planService = deps.interviewPlanService || require('./interviewPlanService');

  const assessment = await Assessment.findById(assessmentId);
  if (!assessment) throw new Error('NOT_FOUND');
  if (assessment.type !== 'interview') return null;

  const cfg = (assessment.config && assessment.config.interview) || {};

  // Honest status up-front so the release gate never lies.
  assessment.config.interview.authoring = { status: 'generating', error: null, questionPlan: null };
  assessment.markModified('config');
  try { await assessment.save(); } catch (_) { /* best-effort early status */ }

  try {
    // Grounding context from the AssessmentSource (same limit as serving).
    let context = '';
    if (cfg.sourceId) {
      const AssessmentSource = getAssessmentSource(deps);
      try {
        const source = await AssessmentSource.findById(cfg.sourceId);
        if (source && source.status === 'ready' && source.extractedText) {
          context = source.extractedText.slice(0, 4000);
        }
      } catch (e) { console.warn('[authorInterview] source lookup failed:', e.message); }
    }

    const plan = await planService.buildQuestionPlan(
      {
        interviewType: cfg.interviewType,
        targetRole: cfg.targetRole,
        targetCompany: cfg.targetCompany,
        difficulty: cfg.difficulty || 'moderate',
        context,
      },
      { aiProvider: deps.aiProvider }
    );

    if (plan.ok) {
      assessment.config.interview.authoring = {
        status: 'ready',
        error: null,
        questionPlan: {
          questions: plan.questions,
          judge: plan.judge || null,
          lint: plan.lint || null,
          rounds: plan.rounds,
        },
      };
      await persistInterviewConfig(Assessment, assessment, { requireUnreleased: true });
    } else {
      assessment.config.interview.authoring = {
        status: 'failed',
        error: plan.error || 'question plan failed QA',
        questionPlan: null,
      };
      await persistInterviewConfig(Assessment, assessment, { requireUnreleased: false });
    }
  } catch (err) {
    if (err && err.message === 'RELEASED') {
      console.warn('[authorInterview] skipped persist — assessment was released mid-authoring');
      throw err;
    }
    try {
      assessment.config.interview.authoring = {
        status: 'failed',
        error: `authoring crashed: ${err && err.message}`,
        questionPlan: null,
      };
      await persistInterviewConfig(Assessment, assessment, { requireUnreleased: false });
    } catch (persistErr) {
      console.warn('[authorInterview] could not persist failed status:', persistErr.message);
    }
    throw err;
  }

  return assessment;
}

/** Same atomic conditional persist as persistMcqConfig, scoped to config.interview. */
async function persistInterviewConfig(Assessment, assessment, { requireUnreleased }) {
  if (Assessment && typeof Assessment.updateOne === 'function') {
    const filter = { _id: assessment._id };
    if (requireUnreleased) filter.status = { $nin: ['released', 'closed'] };
    const res = await Assessment.updateOne(filter, { $set: { 'config.interview': assessment.config.interview } });
    const matched = res ? (res.matchedCount ?? res.n ?? res.modifiedCount ?? 0) : 0;
    if (requireUnreleased && !matched) throw new Error('RELEASED');
    return;
  }
  assessment.markModified('config');
  await assessment.save();
}

/**
 * Author (generate) a capstone bundle for an assessment.
 *
 * Calls requestGeneration to create + enqueue a CapstoneGenerationRequest,
 * then polls until the bundle is ready (status === 'ready') or failed/timeout.
 * Idempotent: if a valid active bundle is already set, returns the assessment as-is.
 *
 * If cfg.sourceId is set and the AssessmentSource is ready:
 *   - Uses source.extractedText (truncated to 2000 chars) as jobDescription
 * Otherwise uses cfg.jobDescription || assessment.title as before.
 *
 * @param {string|ObjectId} assessmentId
 * @param {object}          deps  - injectable: { Assessment, ArtifactBundle,
 *                                    CapstoneGenerationRequest, requestGeneration,
 *                                    sleep, pollMs, maxPolls, AssessmentSource }
 * @returns {Promise<Assessment|null>} updated Assessment, or null if not capstone type
 */
async function authorCapstone(assessmentId, deps = {}) {
  const Assessment = deps.Assessment || require('../../../models/Assessment');
  const ArtifactBundle = deps.ArtifactBundle || require('../../../coding/models/artifactBundle.model');
  const CapstoneGenerationRequest =
    deps.CapstoneGenerationRequest ||
    require('../../../coding/models/capstoneGenerationRequest.model');
  const requestGenerationFn =
    deps.requestGeneration ||
    require('../../../coding/services/capstoneAuthoringSupport').requestGeneration;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs !== undefined ? deps.pollMs : 3000;
  const maxPolls = deps.maxPolls !== undefined ? deps.maxPolls : 60;

  const assessment = await Assessment.findById(assessmentId);
  if (!assessment) throw new Error('NOT_FOUND');

  // Only capstone assessments need bundle authoring
  if (assessment.type !== 'capstone') return null;

  const cfg = assessment.config && assessment.config.capstone ? assessment.config.capstone : {};

  // Idempotent check: if bundleId already set and bundle is active, nothing to do
  if (cfg.bundleId) {
    try {
      const bundle = await ArtifactBundle.findById(cfg.bundleId);
      if (bundle && bundle.status === 'active' && bundle.type === 'capstone') {
        return assessment;
      }
    } catch (_) {
      // If lookup fails, fall through to regenerate
    }
  }

  // Coerce roleTrack + difficulty to valid enum values (CapstoneGenerationRequest model
  // enforces required enums; passing invalid values causes a silent ValidationError).
  const VALID_ROLE_TRACKS = ['swe', 'ds', 'ai_eng'];
  const VALID_DIFFICULTIES = ['easy', 'medium', 'hard'];

  const roleTrack = VALID_ROLE_TRACKS.includes(cfg.roleTrack) ? cfg.roleTrack : 'swe';
  const difficulty = VALID_DIFFICULTIES.includes(cfg.difficulty) ? cfg.difficulty : 'medium';
  // language is required by the model; default by track when not explicitly provided.
  const language = cfg.language || LANG_BY_TRACK[roleTrack] || 'python';

  // ── Grounding: use sourceId text as jobDescription if ready ─────────────────
  let jobDescription = cfg.jobDescription || assessment.title;

  if (cfg.sourceId) {
    const AssessmentSource = getAssessmentSource(deps);
    const source = await AssessmentSource.findById(cfg.sourceId);
    if (source && source.status === 'ready' && source.extractedText) {
      jobDescription = source.extractedText.slice(0, SOURCE_TEXT_LIMIT_CAPSTONE);
    }
  }

  // Request generation
  const reqDoc = await requestGenerationFn(
    {
      userId: assessment.createdBy,
      roleTrack,
      difficulty,
      language,
      jobDescription,
      topicHint: cfg.topicHint,
    },
    deps
  );

  // Poll until ready or failed/timeout
  for (let i = 0; i < maxPolls; i++) {
    await sleep(pollMs);
    const polled = await CapstoneGenerationRequest.findById(reqDoc._id);
    if (!polled) throw new Error('CAPSTONE_GEN_FAILED');
    if (polled.status === 'ready') {
      assessment.config.capstone.bundleId = polled.bundle_id;
      assessment.markModified('config');
      await assessment.save();
      return assessment;
    }
    if (polled.status === 'failed') {
      const err = new Error('CAPSTONE_GEN_FAILED');
      // Real reason lives on the request row (set by the generation pipeline
      // on its last failed attempt — e.g. a validator check that rejected the
      // bundle). Attach it so callers that want to show a TPO more than the
      // bare code can (authorAgentService's runBundleEngine does); routes
      // that only branch on err.message are unaffected.
      if (polled.error) err.detail = polled.error;
      throw err;
    }
  }
  throw new Error('CAPSTONE_GEN_FAILED'); // timeout — no request-level reason to attach
}

/**
 * Author (select) a drill bundle for an assessment.
 *
 * Idempotent: if a valid active drill bundle is already set, returns the assessment as-is.
 * Finds an active ArtifactBundle matching the drill config (roleTrack, drillSubtype, difficulty).
 * If no bundle found, leaves bundleId unset; the release gate will catch it.
 *
 * @param {string|ObjectId} assessmentId
 * @param {object}          deps  - injectable: { Assessment, ArtifactBundle }
 * @returns {Promise<Assessment|null>} updated Assessment, or null if not drill type
 */
async function authorDrill(assessmentId, deps = {}) {
  const Assessment = deps.Assessment || require('../../../models/Assessment');
  const ArtifactBundle = deps.ArtifactBundle || require('../../../coding/models/artifactBundle.model');

  const assessment = await Assessment.findById(assessmentId);
  if (!assessment) throw new Error('NOT_FOUND');
  if (assessment.type !== 'drill') return null;

  const cfg = (assessment.config && assessment.config.drill) || {};

  // Idempotent: valid bundle already set
  if (cfg.bundleId) {
    try {
      const bundle = await ArtifactBundle.findById(cfg.bundleId);
      if (bundle && bundle.status === 'active' && bundle.type === 'drill') {
        return assessment;
      }
    } catch (_) { /* fall through */ }
  }

  // Select an active drill bundle matching the config
  const bundle = await ArtifactBundle.findOne({
    type: 'drill',
    role_track: cfg.roleTrack || 'swe',
    drill_subtype: cfg.drillSubtype,
    difficulty: cfg.difficulty || 'medium',
    status: 'active',
  });

  if (bundle) {
    assessment.config.drill.bundleId = bundle._id;
    assessment.markModified('config');
    await assessment.save();
    return assessment;
  }

  // No library bundle found — generate one
  const generateDrill = deps.generateDrill || (async (params) => require('../../../coding/services/generationPipeline').runPipeline(params));
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs !== undefined ? deps.pollMs : 3000;
  const maxPolls = deps.maxPolls !== undefined ? deps.maxPolls : 60;

  const VALID_ROLE_TRACKS = ['swe', 'ds', 'ai_eng'];
  const roleTrack = VALID_ROLE_TRACKS.includes(cfg.roleTrack) ? cfg.roleTrack : 'swe';
  const language = LANG_BY_TRACK[roleTrack] || 'python';

  let pipelineResult;
  try {
    pipelineResult = await generateDrill({
      role_track: roleTrack,
      drill_subtype: cfg.drillSubtype,
      difficulty: cfg.difficulty || 'medium',
      language,
    });
  } catch (e) {
    // Fire-and-forget: never throw. Leave bundleId unset.
    console.warn('[assessmentAuthoring:authorDrill] generateDrill error:', e.message);
    return assessment;
  }

  if (!pipelineResult || !pipelineResult.bundle_id) return assessment;

  // Poll until the ArtifactBundle is status 'active'
  for (let i = 0; i < maxPolls; i++) {
    await sleep(pollMs);
    const polled = await ArtifactBundle.findById(pipelineResult.bundle_id);
    if (polled && polled.status === 'active') {
      assessment.config.drill.bundleId = polled._id;
      assessment.markModified('config');
      await assessment.save();
      return assessment;
    }
  }
  // Timeout — leave bundleId unset; never throw
  console.warn('[assessmentAuthoring:authorDrill] polling timeout, bundleId left unset');
  return assessment;
}

module.exports = { authorMcq, authorInterview, authorCapstone, authorDrill, regenerateQuestion, _helpers: { buildGroundingText, accumulateReport } };
