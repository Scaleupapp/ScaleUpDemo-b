const mongoose = require('mongoose');
const openai = require('../config/openai');
const Content = require('../models/Content');
const Quiz = require('../models/Quiz');
const QuizTrigger = require('../models/QuizTrigger');
const KnowledgeProfile = require('../models/KnowledgeProfile');
const UserObjective = require('../models/UserObjective');
const userContextService = require('./userContextService');
const { notificationQueue } = require('../config/queue');
const { DIFFICULTY_MIX } = require('../utils/constants');

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
};

class QuizGenerationService {

  async generateQuiz({ triggerId, userId, topic, contentIds, type, questionCount: requestedCount, objectiveId, assessmentType, isSkillAssessment, suppressNotification, noObjective }) {
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
    const difficultyMix = DIFFICULTY_MIX[level] || DIFFICULTY_MIX.beginner;

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
    try {
      const objective = noObjective
        ? null
        : (objectiveId
            ? await UserObjective.findById(objectiveId)
            : await UserObjective.findOne({ userId, status: 'active', isPrimary: true }));

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

      const userPrompt = JSON.stringify(promptData) + userContextBlock + externalContext;
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
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
        });

        const contResponse = await openai.chat.completions.create({
          model: 'gpt-4o',
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

        questions.push(...newQuestions);
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

    const quiz = await Quiz.create({
      userId, title: quizTitle, type: quizType, topic,
      sourceContentIds: contentIds || [],
      questions: sanitizedQuestions,
      totalQuestions: questions.length,
      timePerQuestion,
      assessmentType: effectiveAssessmentType || undefined,
      linkedCompetencies: linkedCompetencies.length > 0 ? linkedCompetencies : undefined,
      // Honor noObjective — for-fun quizzes don't get linked to the user's goal.
      objectiveId: noObjective ? undefined : (objectiveId || undefined),
      status: 'ready',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
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
