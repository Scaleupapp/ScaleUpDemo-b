const mongoose = require('mongoose');
const { OPENAI_CHAT_MODEL } = require('../config/openaiModels');
const openai = require('../config/openai');
const Content = require('../models/Content');
const Quiz = require('../models/Quiz');
const QuizTrigger = require('../models/QuizTrigger');
const KnowledgeProfile = require('../models/KnowledgeProfile');
const UserObjective = require('../models/UserObjective');
const userContextService = require('./userContextService');
const { notificationQueue } = require('../config/queue');
const { DIFFICULTY_MIX } = require('../utils/constants');
// Gate-1 deterministic lint (pure code, no LLM). Runs on EVERY quiz generation
// — D2C included — to drop malformed/leaky/duplicate items so the existing
// top-up loop replaces them. Requiring this module is cheap (no client init).
const questionQaService = require('./institution/assessment/questionQaService');

const QUIZ_SYSTEM_PROMPT = `You are an expert educational assessment creator. Your quizzes must actually test understanding — not be trivially solvable by elimination.

CONTENT RULES:
1. Each question must directly test understanding of the provided content.
2. Include the sourceContentId and sourceTimestamp for each question when available.
3. Mix question types based on the assessmentType provided (or use a balanced mix if "mixed").
4. Provide a clear explanation that reinforces the concept, not just restates the answer.
5. Each question must have exactly 4 options (A, B, C, D).

DIFFICULTY RULES:
6. Respect the difficultyMix ratios passed in (easy/medium/hard). Match the userLevel — do not make a beginner quiz trivially easy with only recall, and do not overload an advanced quiz with obscure edge cases.
7. "easy" = recall/recognition; "medium" = apply a concept to a new example; "hard" = multi-step reasoning, compare/contrast, edge cases, or identify subtle mistakes.

DISTRACTOR QUALITY (CRITICAL — this is what separates a real quiz from a toy):
8. Every distractor (wrong option) must be a PLAUSIBLE answer — something a learner with a partial or common misunderstanding would genuinely pick. Use known misconceptions, adjacent concepts, off-by-one answers, or right-answer-wrong-context traps.
9. NO joke distractors, absurd options, or obviously wrong throwaways.
10. NO "All of the above" or "None of the above".
11. Keep all four options roughly the same length and structure. The correct answer must not be the longest, most detailed, or most "textbook-worded" option — that is a known AI-generated-quiz tell and defeats the assessment.
12. The correct option MUST NOT repeat distinctive keywords from the question stem if the distractors don't. (No keyword leakage.)
13. Distractors must be mutually exclusive from the correct answer — not paraphrases of it.
14. Randomize which letter (A/B/C/D) holds the correct answer across the quiz — do not bias toward any single letter.

DISTRACTOR MISCONCEPTION TAGGING (REQUIRED — used by the platform to track per-user learning patterns):
15. For EACH distractor option (NOT the correct one), include a "misconception" object with:
    - tag: a short snake_case identifier of the false belief (e.g. "treats_correlation_as_causation", "off_by_one_indexing", "confuses_p_a_given_b_with_p_b_given_a", "applies_formula_outside_assumptions"). Use stable, reusable tags — the same misconception in different questions should use the same tag.
    - explanation: one sentence in plain English describing what the learner who picked this option is misunderstanding.
16. The correct option's "misconception" field must be omitted or set to null.
17. Tags should be domain-meaningful, not generic. "wrong_answer" is forbidden. "guesses_randomly" is forbidden. Tags must capture a SPECIFIC misconception a real learner could hold.

OUTPUT RULES:
18. CRITICAL: Generate EXACTLY the number of questions specified in "questionCount". Not fewer, not more.
19. Return valid JSON with a "questions" array where each question has:
   - questionText, questionType, options (array of {label, text, misconception: {tag, explanation} | null}), correctAnswer (A/B/C/D),
     explanation, difficulty (easy/medium/hard), sourceContentId, sourceTimestamp, concept`;

const COMPETENCY_QUIZ_SYSTEM_PROMPT = `You are an expert educational assessment creator specializing in competency-based evaluation. Your quizzes must meaningfully discriminate between learners at different levels — not be solvable by elimination.

Generate assessment questions that measure specific competencies. Each question must:
1. Be tagged with the competency it measures.
2. Use the appropriate question type for that competency.
3. Include scenario/context when the assessment type calls for it.
4. Have exactly 4 options (A, B, C, D).
5. Optionally allow text response for deeper evaluation (set allowTextResponse: true with a textPrompt).
6. Include a per-question timeLimit in seconds (default: 60, scenarios: 120, case studies: 180).

DISTRACTOR QUALITY (CRITICAL):
- Every wrong option must be a PLAUSIBLE answer a learner with a common misunderstanding would actually pick (known misconceptions, adjacent frameworks, right-answer-wrong-context, off-by-one reasoning).
- NO joke distractors, "All of the above", or "None of the above".
- Options must be roughly equal in length and writing style — the correct answer must NOT be the longest or most detailed option.
- Do not leak the answer by repeating unique keywords from the stem only in the correct option.
- Randomize the correct letter across the quiz; do not bias toward any single letter.
- Distractors must be mutually exclusive from the correct answer, not paraphrases.

DISTRACTOR MISCONCEPTION TAGGING (REQUIRED):
- For EACH distractor option, include a "misconception" object: { tag: snake_case stable identifier (e.g. "confuses_competency_with_seniority", "applies_framework_outside_context"), explanation: one sentence describing the misunderstanding }.
- The correct option's "misconception" must be omitted or null.
- Use stable tags — the same misconception across different questions must use the same tag. Avoid generic tags like "wrong_answer" or "guesses_randomly".

DIFFICULTY: Match the user's current level. Beginners get recall + simple application; advanced learners get multi-step reasoning, edge cases, and compare/contrast.

CRITICAL: Generate EXACTLY the number of questions specified in "questionCount". Not fewer, not more.

IMPORTANT: questionType MUST be one of these exact values:
- "recall" — Direct factual/conceptual questions, 60s
- "application" — Present a real-world scenario, ask what to do, 90-120s
- "situational" — Workplace/people situations, evaluate judgment, 90s
- "framework" — Apply a framework/model to a situation, 120s
- "conceptual" — Test understanding of concepts and principles, 60-90s
- "critical_thinking" — Analyze and evaluate complex situations, 90s
- "case_study" — Complex multi-factor scenario, 120-180s

Assessment approach by competency type:
- knowledge_recall competencies → use "recall" or "conceptual" questionType
- applied_scenario competencies → use "application" questionType with a scenario field
- situational_judgment competencies → use "situational" questionType with a scenario field
- framework_application competencies → use "framework" questionType
- exam_style competencies → use "conceptual" or "recall" questionType
- case_study competencies → use "case_study" questionType with a scenario field

Return valid JSON with a "questions" array where each question has:
  - questionText, questionType (MUST be one of: recall, application, conceptual, critical_thinking, situational, framework, case_study),
    options (array of {label, text}), correctAnswer (A/B/C/D),
    explanation, difficulty (easy/medium/hard), concept, competency,
    scenario (optional — for application, situational, case_study),
    allowTextResponse (boolean), textPrompt (optional — e.g. "Explain your reasoning"),
    timeLimit (seconds)`;

const DIAGNOSTIC_QUIZ_SYSTEM_PROMPT = `You are an expert assessment designer building a SHORT diagnostic quiz to estimate a learner's current proficiency. The output is used to seed a personalised learning plan, NOT to teach.

OUTPUT REQUIREMENTS:
- Generate questions evenly across 3 difficulty buckets per competency:
  - "easy"   = recall / recognition
  - "medium" = apply concept to a new example
  - "hard"   = multi-step reasoning, edge cases, compare/contrast
- Each question has 4 options, exactly one correct, all four roughly equal in length and writing style.
- Distractors must be PLAUSIBLE common misconceptions, NOT joke options.
- Every distractor carries a misconception object: { tag (snake_case stable identifier), explanation (one human sentence). }
- Correct option's misconception is null/omitted.
- Randomise the correct letter across the set.

DIAGNOSTIC-SPECIFIC RULES (different from teaching quizzes):
- Each question stands alone — no narrative flow assumed across the set.
- Avoid "trick" questions; we want signal about real proficiency, not gotchas.
- For coding competencies, use MCQ-format only: read snippet → predict output / find bug / pick syntax. NEVER ask the learner to write code.

OUTPUT FORMAT: strict JSON: { "questions": [ { competency, difficulty, questionText, options:[{label,text,misconception?}], correctAnswer, explanation }, ... ] }`;

// Map trigger types to Quiz model enum values
const TRIGGER_TO_QUIZ_TYPE = {
  topic_threshold: 'topic_consolidation',
  weekly_checkpoint: 'weekly_review',
  playlist_completed: 'playlist_mastery',
  plan_milestone: 'milestone_assessment',
  retention_check: 'retention_check',
  on_demand: 'on_demand',
  daily_top_gap: 'daily_top_gap',
};

class QuizGenerationService {

  async generateQuiz({ triggerId, userId, topic, contentIds, type, questionCount: requestedCount, objectiveId, assessmentType, isSkillAssessment, suppressNotification, noObjective, source, weekNumber, injectedCompetencies, groundingText }) {
    // ── Institution-only additive params (never passed by D2C callers) ─────────
    //   injectedCompetencies: [{ name, category, weight }] — forces the
    //     competency prompt path so each question emits a `competency` tag even
    //     when noObjective is set (placement MCQs have no UserObjective).
    //   groundingText: syllabus/JD excerpt injected into the prompt so items are
    //     answerable from the source domain.
    //   When both are absent the method behaves byte-identically to before.
    const quizType = isSkillAssessment ? 'competency_assessment' : (TRIGGER_TO_QUIZ_TYPE[type] || 'topic_consolidation');

    // Resolve content — contentIds may be empty for on-demand topic quizzes
    let contents = [];
    if (contentIds && contentIds.length > 0) {
      contents = await Content.find({ _id: { $in: contentIds } });
    }

    const conceptData = contents.map(c => ({
      contentId: c._id.toString(),
      title: c.title,
      concepts: c.aiData?.keyConcepts || [],
    }));

    const profile = await KnowledgeProfile.findOne({ userId });
    const topicMastery = profile?.topicMastery.find(t => t.topic === topic);
    const level = topicMastery?.level || 'beginner';
    const targetDifficulty = topicMastery?.targetDifficulty || 'medium';

    // Start from the level-based mix, then bias toward targetDifficulty.
    // Mix values are percentages (0-100).  Shift +30 into the target bucket,
    // taking -20 from medium and -10 from the remaining bucket (clamped at 0).
    let difficultyMix = { ...(DIFFICULTY_MIX[level] || DIFFICULTY_MIX.beginner) };
    if (targetDifficulty === 'hard') {
      difficultyMix.hard  = Math.min(100, (difficultyMix.hard  || 0) + 30);
      difficultyMix.medium = Math.max(0,  (difficultyMix.medium || 0) - 20);
      difficultyMix.easy   = Math.max(0,  (difficultyMix.easy   || 0) - 10);
    } else if (targetDifficulty === 'easy') {
      difficultyMix.easy   = Math.min(100, (difficultyMix.easy   || 0) + 30);
      difficultyMix.medium = Math.max(0,   (difficultyMix.medium || 0) - 20);
      difficultyMix.hard   = Math.max(0,   (difficultyMix.hard   || 0) - 10);
    }
    // 'medium' uses the level-default mix unchanged

    const defaultCount = quizType === 'retention_check' ? 5 :
                          quizType === 'weekly_review' ? 12 :
                          quizType === 'milestone_assessment' ? 15 : 10;
    const questionCount = requestedCount || defaultCount;

    // Check if user has an active objective with competency analysis.
    // When `noObjective` is set (user generated a "for fun" quiz), skip the
    // lookup entirely so the quiz isn't tagged to their goal or counted
    // toward objective progress.
    let competencyContext = null;
    let linkedCompetencies = [];
    // User's explicit choice always takes priority
    let effectiveAssessmentType = assessmentType || null;
    // Resolved objective id we'll persist on the Quiz doc. When the caller
    // explicitly passed `objectiveId` we honor it; otherwise (and when
    // `noObjective` is not set) we resolve the user's primary active objective
    // and persist THAT id. Without this fallback, Compass-generated quizzes
    // with the "link to my objective" toggle ON would land in the DB with
    // objectiveId=null — and the iOS history view tags every null-objective
    // quiz as "For fun", which is the bug we're fixing.
    let resolvedObjectiveId = noObjective ? null : (objectiveId || null);
    try {
      const objective = noObjective
        ? null
        : (objectiveId
            ? await UserObjective.findById(objectiveId)
            : await UserObjective.findOne({ userId, status: 'active', isPrimary: true }));

      // Capture the resolved objective's id so we can stamp it on the Quiz
      // doc below even when the caller didn't pass one.
      if (objective && !resolvedObjectiveId) {
        resolvedObjectiveId = objective._id;
      }

      if (objective?.analysis?.competencies?.length > 0) {
        // Find competencies relevant to this topic
        const relevantComps = objective.analysis.competencies.filter(c => {
          const compName = c.name.toLowerCase();
          const t = topic.toLowerCase();
          return compName.includes(t) || t.includes(compName) ||
            compName.split(/[\s-]+/).some(word => t.includes(word));
        });

        if (relevantComps.length > 0) {
          linkedCompetencies = relevantComps.map(c => c.name);
          competencyContext = {
            objectiveType: objective.objectiveType,
            specifics: objective.specifics,
            competencies: relevantComps.map(c => ({
              name: c.name,
              category: c.category,
              weight: c.weight,
              assessmentTypes: c.assessmentTypes,
              currentLevel: topicMastery?.level || 'beginner',
            })),
          };

          // Only use analysis recommendation if user didn't explicitly pick a type
          if (!effectiveAssessmentType && objective.analysis.assessmentStrategy?.recommended) {
            const rec = objective.analysis.assessmentStrategy.recommended.find(
              r => linkedCompetencies.includes(r.competency)
            );
            effectiveAssessmentType = rec?.assessmentType || null;
          }
        }
      }
    } catch (e) {
      console.log('[QuizGeneration] Could not load objective context:', e.message);
    }

    // Institution authoring: when the caller injects competencies explicitly and
    // no objective-derived context was resolved, build a competency context from
    // them. This routes generation through COMPETENCY_QUIZ_SYSTEM_PROMPT so each
    // question is tagged with a `competency` (needed for competencyBreakdown /
    // rollups / CSV). Additive: D2C callers never pass injectedCompetencies.
    if (!competencyContext && Array.isArray(injectedCompetencies) && injectedCompetencies.length > 0) {
      linkedCompetencies = injectedCompetencies.map((c) => c.name).filter(Boolean);
      competencyContext = {
        objectiveType: 'placement_assessment',
        specifics: {},
        competencies: injectedCompetencies
          .filter((c) => c && c.name)
          .map((c) => ({
            name: c.name,
            category: c.category || 'core',
            weight: c.weight,
            currentLevel: level,
          })),
      };
    }

    // Choose system prompt based on whether we have competency context
    const systemPrompt = competencyContext ? COMPETENCY_QUIZ_SYSTEM_PROMPT : QUIZ_SYSTEM_PROMPT;

    // Build the user prompt
    const promptData = {
      topic,
      userLevel: level,
      difficultyMix,
      questionCount,
      assessmentType: effectiveAssessmentType || 'mixed',
      contents: conceptData.length > 0
        ? conceptData
        : [],
    };

    if (competencyContext) {
      promptData.competencyContext = competencyContext;
    }

    // Plan-context variant seed: when this quiz is being generated for a
    // specific week of a multi-week plan, pass the week number as a variant
    // seed so the LLM produces different questions for week 4 vs week 17
    // even when the topic is identical. Without this, revisited topics in
    // long plans (e.g. SDE 26-week plans hitting "dynamic-programming" four
    // times) would feel like the same quiz every time.
    const isPlanContext = source === 'plan' || (weekNumber != null);
    if (isPlanContext) {
      promptData.planContext = {
        weekNumber: weekNumber || null,
        variantInstruction: weekNumber
          ? `This quiz is for WEEK ${weekNumber} of a multi-week learning plan on this topic. ` +
            `If the learner has taken earlier weeks' quizzes on the same topic, this one should ` +
            `feel like a continuation: same fundamentals, different scenarios and angles, slightly ` +
            `harder edge cases. Do not repeat questions verbatim — vary the framing, numbers, ` +
            `domain examples, and the specific sub-concept emphasized.`
          : `This quiz is part of a multi-week plan. Vary framing, scenarios, and emphasized ` +
            `sub-concepts from any earlier quizzes the learner has taken on this topic.`,
      };
    }

    // Pull recent attempts' first 1-2 question texts so the LLM can avoid
    // repeating them. Cheap query — last 30 attempts on this topic for this
    // user, plus the questionText from the matching quizzes' first two
    // questions. Best-effort; failures don't block generation.
    let avoidQuestionsBlock = '';
    try {
      if (userId && topic) {
        const QuizAttempt = require('../models/QuizAttempt');
        const recentAttempts = await QuizAttempt.find({ userId })
          .sort({ createdAt: -1 })
          .limit(30)
          .select('quizId')
          .lean();
        const recentQuizIds = recentAttempts.map(a => a.quizId).filter(Boolean);
        if (recentQuizIds.length > 0) {
          const recentQuizzes = await Quiz.find({
            _id: { $in: recentQuizIds },
            topic,
          })
            .select('questions')
            .limit(30)
            .lean();
          const avoidQuestions = [];
          for (const q of recentQuizzes) {
            const firstTwo = (q.questions || []).slice(0, 2);
            for (const qq of firstTwo) {
              if (qq?.questionText) avoidQuestions.push(qq.questionText);
            }
          }
          if (avoidQuestions.length > 0) {
            const trimmed = avoidQuestions.slice(0, 20).map((s, i) => `${i + 1}. ${String(s).slice(0, 180)}`);
            avoidQuestionsBlock = `\n\nAVOID — these are questions the learner has already seen on this topic. Do NOT repeat them or trivially rephrase them. Produce fresh scenarios and angles.\navoidQuestionsContaining:\n${trimmed.join('\n')}`;
          }
        }
      }
    } catch (err) {
      console.warn('[quizGeneration] avoid-questions lookup failed:', err.message);
    }

    if (isSkillAssessment && conceptData.length === 0) {
      promptData.note = `This is a SKILL ASSESSMENT for the competency "${topic}". Generate market-standard assessment questions that measure real-world proficiency in this skill. Questions should NOT depend on any specific training content — use industry-standard knowledge and best practices.`;
    } else if (conceptData.length === 0) {
      promptData.note = `Generate questions about "${topic}" based on general knowledge. No specific source content available.`;
    }

    // Cross-context personalisation — give the quiz model what we know about
    // the learner across the platform (gaps, misconceptions, recent tutor
    // topics, spaced-repetition due concepts, objective). Keeps the prompt
    // grounded in this user instead of generic. ~250 tokens of digest.
    let userContextBlock = '';
    try {
      const ctx = await userContextService.getUserContext(userId);
      const oneLiner = userContextService.summarize(ctx);
      const weak = (ctx.weakTopics || []).slice(0, 3)
        .map(t => `${t.topic} (${t.score}%)`).join(', ');
      const recent = (ctx.recentTopicsTouched || []).slice(0, 4).join(', ');
      const misc = (ctx.misconceptions || []).slice(0, 2)
        .map(m => `${m.tag} — ${m.explanation}`).join('; ');
      const due = (ctx.dueForReview || []).slice(0, 3).map(d => d.concept).join(', ');
      const lines = [];
      if (oneLiner) lines.push(oneLiner);
      if (weak) lines.push(`Known weak topics: ${weak}.`);
      if (recent) lines.push(`Recently quizzed topics: ${recent}.`);
      if (misc) lines.push(`Recurring misconceptions to probe (don't gloss over these): ${misc}.`);
      if (due) lines.push(`Concepts overdue for spaced review: ${due}.`);
      if (lines.length) {
        userContextBlock = `\n\nLEARNER CONTEXT — use this to make questions feel like the system knows this user. Weave in their misconceptions as distractors when natural, and slightly favour topics they've recently struggled with.\n${lines.join('\n')}`;
      }
    } catch (err) {
      console.warn('[quizGeneration] user-context lookup failed:', err.message);
    }

    // C2O loop: pull excerpts from external content the user has actually consumed
    // on this topic, so the quiz tests what they read/watched.
    let externalContext = '';
    try {
      const ExternalContentTouch = require('../models/ExternalContentTouch');
      const ExternalContentSnapshot = require('../models/ExternalContentSnapshot');
      const touches = await ExternalContentTouch.find({
        userId, topicCanonicalName: topic,
      }).sort({ completedAt: -1 }).limit(3).lean();
      const urls = touches.map(t => t.url).filter(Boolean);
      if (urls.length > 0) {
        const snapshots = await ExternalContentSnapshot.find({ url: { $in: urls } })
          .select('url title excerpt').lean();
        const excerpts = snapshots
          .map(s => `[${s.title || s.url}]\n${(s.excerpt || '').slice(0, 1500)}`)
          .filter(s => s.length > 20);
        if (excerpts.length > 0) {
          externalContext = `\n\nADDITIONAL CONTEXT — external resources the user recently consumed on this topic:\n${excerpts.join('\n\n---\n\n')}\n\nWhere natural, base 1-2 questions on this material so the quiz reinforces what the user actually read.`;
        }
      }
    } catch (err) {
      console.warn('[quizGeneration] C2O external-context lookup failed:', err.message);
    }

    // Institution grounding: inject the syllabus/JD excerpt so items are
    // answerable from the source domain. Additive — empty for D2C callers.
    let groundingBlock = '';
    if (groundingText && String(groundingText).trim()) {
      groundingBlock = `\n\nSYLLABUS / SOURCE MATERIAL — the assessment must be answerable from THIS domain. Ground every question in the concepts, terminology, and scope below. Do NOT drift to unrelated interpretations of any term.\n${String(groundingText).slice(0, 6000)}`;
    }

    let questions;
    try {
      // Scale max_tokens based on question complexity:
      // - Regular recall/mixed: ~500 tokens/question
      // - Competency-based: ~700 tokens/question (scenarios, text prompts, time limits)
      // - Case study/applied_scenario: ~800 tokens/question (long scenarios)
      const complexTypes = ['case_study', 'applied_scenario', 'situational_judgment', 'exam_style'];
      const isComplexType = complexTypes.includes(effectiveAssessmentType);
      const tokensPerQuestion = competencyContext ? 700 : isComplexType ? 800 : 500;
      const maxTokens = Math.max(4096, questionCount * tokensPerQuestion);

      console.log(`[QuizGeneration] Calling OpenAI for topic="${topic}", questionCount=${questionCount}, assessmentType=${effectiveAssessmentType || 'mixed'}, contentCount=${conceptData.length}, competencyAware=${!!competencyContext}, maxTokens=${maxTokens}`);

      const userPrompt = JSON.stringify(promptData) + userContextBlock + externalContext + avoidQuestionsBlock + groundingBlock;
      const response = await openai.chat.completions.create({
        model: OPENAI_CHAT_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.7,
        max_tokens: maxTokens,
      });

      const parsed = JSON.parse(response.choices[0].message.content);
      questions = parsed.questions;

      if (!questions || !Array.isArray(questions) || questions.length === 0) {
        throw new Error(`OpenAI returned invalid quiz data: no questions array`);
      }

      // Gate-1 lint (pure code): drop malformed/leaky/duplicate items. The
      // top-up loop below refills any dropped slots. Applies to every caller.
      {
        const before = questions.length;
        const g1 = questionQaService.gate1Filter(questions, { topic });
        questions = g1.kept;
        if (g1.dropped.length > 0) {
          console.log(`[QuizGeneration] Gate-1 dropped ${g1.dropped.length}/${before} question(s): ${g1.dropped.map((d) => d.reason).join(', ')}`);
        }
      }

      console.log(`[QuizGeneration] OpenAI returned ${questions.length}/${questionCount} questions for topic="${topic}"`);

      // If we got fewer questions than requested, make follow-up calls for the remainder
      const MAX_CONTINUATION_ATTEMPTS = 3;
      let attempt = 0;
      while (questions.length < questionCount && attempt < MAX_CONTINUATION_ATTEMPTS) {
        attempt++;
        const remaining = questionCount - questions.length;
        console.log(`[QuizGeneration] Continuation call ${attempt}: need ${remaining} more questions for topic="${topic}"`);

        const continuationPrompt = JSON.stringify({
          ...promptData,
          questionCount: remaining,
          note: `You already generated ${questions.length} questions. Generate exactly ${remaining} MORE unique questions on the same topic "${topic}". Do NOT repeat any of these existing questions: ${questions.map((q, i) => `Q${i+1}: ${q.questionText.substring(0, 60)}`).join('; ')}`,
        }) + groundingBlock;

        const contResponse = await openai.chat.completions.create({
          model: OPENAI_CHAT_MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: continuationPrompt },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.75,
          max_tokens: Math.max(4096, remaining * tokensPerQuestion),
        });

        const contParsed = JSON.parse(contResponse.choices[0].message.content);
        const newQuestions = contParsed.questions;

        if (!newQuestions || !Array.isArray(newQuestions) || newQuestions.length === 0) {
          console.warn(`[QuizGeneration] Continuation call ${attempt} returned no questions, stopping`);
          break;
        }

        // Gate-1 lint the new batch against the already-kept set (dedup scoped
        // to this quiz) — accepted items are appended, rejects await the next round.
        {
          const g1 = questionQaService.gate1Filter(newQuestions, { topic, existing: questions });
          const acceptedCount = g1.kept.length - questions.length;
          questions = g1.kept;
          if (g1.dropped.length > 0) {
            console.log(`[QuizGeneration] Gate-1 (continuation ${attempt}) dropped ${g1.dropped.length}, kept ${acceptedCount}`);
          }
        }
        console.log(`[QuizGeneration] After continuation ${attempt}: ${questions.length}/${questionCount} questions`);
      }

      // Trim to exact count if we somehow got more
      if (questions.length > questionCount) {
        questions = questions.slice(0, questionCount);
      }

      if (questions.length < questionCount) {
        console.warn(`[QuizGeneration] Could only generate ${questions.length}/${questionCount} questions after ${attempt} continuation attempts for topic="${topic}"`);
      }
    } catch (err) {
      console.error(`[QuizGeneration] OpenAI call failed for topic="${topic}":`, err.message);

      // Update trigger status to failed so frontend can detect the failure
      if (triggerId) {
        await QuizTrigger.findByIdAndUpdate(triggerId, { status: 'failed' });
      }

      throw err; // Re-throw so BullMQ marks the job as failed
    }

    // Map AI-generated questionType values to valid Quiz schema enum values
    const QUESTION_TYPE_MAP = {
      knowledge_recall: 'recall',
      applied_scenario: 'application',
      situational_judgment: 'situational',
      framework_application: 'framework',
      exam_style: 'conceptual',
      cross_content: 'cross_content',
    };
    const VALID_QUESTION_TYPES = new Set(['conceptual', 'application', 'cross_content', 'recall', 'critical_thinking', 'situational', 'framework', 'case_study']);

    // Sanitize questions: fix questionType + strip invalid ObjectId values
    const validContentIds = new Set((contentIds || []).map(id => id.toString()));
    const sanitizedQuestions = questions.map(q => {
      const clean = { ...q };

      // Map questionType to valid enum value
      if (clean.questionType) {
        if (!VALID_QUESTION_TYPES.has(clean.questionType)) {
          clean.questionType = QUESTION_TYPE_MAP[clean.questionType] || 'conceptual';
        }
      }

      // Remove sourceContentId if it's not a valid ObjectId or not in our content set
      if (clean.sourceContentId) {
        const isValidObjectId = mongoose.Types.ObjectId.isValid(clean.sourceContentId);
        if (!isValidObjectId || (validContentIds.size > 0 && !validContentIds.has(clean.sourceContentId))) {
          delete clean.sourceContentId;
        }
      }
      return clean;
    });

    const quizTitle = isSkillAssessment ? `${topic} — Skill Assessment` : `${topic} — Knowledge Check`;

    // Set time per question based on assessment complexity
    const TIME_PER_QUESTION = {
      knowledge_recall: 60,
      applied_scenario: 90,
      situational_judgment: 90,
      framework_application: 120,
      exam_style: 90,
      case_study: 150,
      competency_gate: 90,
      mixed: 75,
    };
    const timePerQuestion = TIME_PER_QUESTION[effectiveAssessmentType] || 60;

    // Compute expiresAt. Plan-context quizzes (signalled by source==='plan'
    // or by an explicit weekNumber) get a long-lived expiry tied to the
    // objective's targetDate — previously every quiz expired in 7 days,
    // which meant a quiz generated at plan time for week 17 was already
    // expired when the user reached it. Standalone Compass quizzes keep
    // the 7-day expiry.
    let expiresAt;
    if (isPlanContext) {
      try {
        if (resolvedObjectiveId) {
          const planObjective = await UserObjective.findById(resolvedObjectiveId)
            .select('targetDate')
            .lean();
          if (planObjective?.targetDate) {
            expiresAt = new Date(new Date(planObjective.targetDate).getTime() + 30 * 24 * 60 * 60 * 1000);
          }
        }
      } catch (e) { /* fall through to undefined → no TTL */ }
      // If we couldn't resolve a target date, leave expiresAt unset (no TTL).
    } else {
      expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    }

    const quiz = await Quiz.create({
      userId, title: quizTitle, type: quizType, topic,
      sourceContentIds: contentIds || [],
      questions: sanitizedQuestions,
      totalQuestions: questions.length,
      timePerQuestion,
      assessmentType: effectiveAssessmentType || undefined,
      linkedCompetencies: linkedCompetencies.length > 0 ? linkedCompetencies : undefined,
      // Honor noObjective — for-fun quizzes don't get linked to the user's goal.
      // When the toggle is OFF and the caller didn't pass an explicit objectiveId,
      // we stamp the resolved primary-active objective so the iOS history view
      // shows the quiz as plan-linked instead of falsely tagging it "For fun".
      objectiveId: noObjective ? undefined : (resolvedObjectiveId || undefined),
      status: 'ready',
      expiresAt,
      generatedAt: new Date(),
    });

    if (triggerId) {
      await QuizTrigger.findByIdAndUpdate(triggerId, { quizId: quiz._id, status: 'generated' });
    }

    // Skip per-quiz pushes when the caller is in a bulk-generation path
    // (e.g. plan generation seeds 10-15 quizzes at once — sending a push
    // per quiz spams the user. The plan-ready notification covers the batch).
    if (!suppressNotification) {
      await notificationQueue.add('send', {
        userId, title: 'Quiz Ready!',
        body: `Test your ${topic} knowledge — ${quiz.totalQuestions} questions from your recent learning.`,
        data: { type: 'quiz_ready', quizId: quiz._id },
      });
    }

    console.log(`[QuizGeneration] Quiz created: id=${quiz._id}, topic="${topic}", questions=${quiz.totalQuestions}, competencyAware=${!!competencyContext}`);
    return quiz;
  }
}

const _instance = new QuizGenerationService();
_instance.DIAGNOSTIC_QUIZ_SYSTEM_PROMPT = DIAGNOSTIC_QUIZ_SYSTEM_PROMPT;
module.exports = _instance;
