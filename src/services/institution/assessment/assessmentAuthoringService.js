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

function getModel(deps) { return (deps && deps.Assessment) || require('../../../models/Assessment'); }
function getQuiz(deps) { return (deps && deps.Quiz) || require('../../../models/Quiz'); }
function getContent(deps) { return (deps && deps.Content) || require('../../../models/Content'); }
function getQuizGenerationService(deps) {
  return (deps && deps.quizGenerationService) || require('../../quizGenerationService');
}
function getAssessmentSource(deps) {
  return (deps && deps.AssessmentSource) || require('../../../models/AssessmentSource');
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

  // ── Grounding: load AssessmentSource when sourceId is configured ────────────
  let transientContentId = null;
  let contentIds = undefined;

  if (cfg.sourceId) {
    const AssessmentSource = getAssessmentSource(deps);
    const source = await AssessmentSource.findById(cfg.sourceId);
    if (source && source.status === 'ready') {
      // Create a transient Content doc so generateQuiz can inject concepts
      const Content = getContent(deps);
      const keyConcepts = (source.extractedTopics || []).map((t) => ({
        concept: t.name,
        description: '',
        importance: 'high',
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
    }
  }

  // ── Call quizGenerationService ────────────────────────────────────────────
  // suppressNotification + noObjective prevent D2C side-effects.
  const quizGenerationService = getQuizGenerationService(deps);
  const generateArgs = {
    userId: assessment.createdBy,
    topic: cfg.topic || assessment.title,
    questionCount: cfg.totalQuestions || 10,
    assessmentType: cfg.assessmentType || 'mixed',
    isSkillAssessment: true,
    suppressNotification: true,
    noObjective: true,
  };
  if (contentIds) generateArgs.contentIds = contentIds;

  const quiz = await quizGenerationService.generateQuiz(generateArgs);

  // Freeze questions onto the assessment config so the release gate can check them.
  assessment.config.mcq.questions = quiz.questions;
  assessment.config.mcq.totalQuestions = quiz.questions.length;
  assessment.markModified('config');
  await assessment.save();

  // Best-effort: delete the throwaway quiz so it never appears in D2C history.
  const Quiz = getQuiz(deps);
  if (typeof Quiz.findByIdAndDelete === 'function') {
    try {
      await Quiz.findByIdAndDelete(quiz._id);
    } catch (e) {
      console.warn('[assessmentAuthoring] Could not delete throwaway quiz:', e.message);
    }
  }

  // Best-effort: delete the transient Content doc.
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

  return assessment;
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
  const LANG_BY_TRACK = { swe: 'javascript', ds: 'python', ai_eng: 'python' };

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
    if (polled.status === 'failed') throw new Error('CAPSTONE_GEN_FAILED');
  }
  throw new Error('CAPSTONE_GEN_FAILED'); // timeout
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
  }
  // If none found: leave bundleId unset; release gate will catch it.
  return assessment;
}

module.exports = { authorMcq, authorCapstone, authorDrill };
