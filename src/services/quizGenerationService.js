const mongoose = require('mongoose');
const openai = require('../config/openai');
const Content = require('../models/Content');
const Quiz = require('../models/Quiz');
const QuizTrigger = require('../models/QuizTrigger');
const KnowledgeProfile = require('../models/KnowledgeProfile');
const UserObjective = require('../models/UserObjective');
const { notificationQueue } = require('../config/queue');
const { DIFFICULTY_MIX } = require('../utils/constants');

const QUIZ_SYSTEM_PROMPT = `You are an expert educational assessment creator.
Generate a quiz based on the provided content. Rules:
1. Each question must directly test understanding of the provided content
2. Include the sourceContentId and sourceTimestamp for each question when available
3. Mix question types based on the assessmentType provided (or use a balanced mix if "mixed")
4. Provide clear explanations for correct answers
5. Each question must have exactly 4 options (A, B, C, D)
6. CRITICAL: Generate EXACTLY the number of questions specified in "questionCount". Not fewer, not more.
7. Return valid JSON with a "questions" array where each question has:
   - questionText, questionType, options (array of {label, text}), correctAnswer (A/B/C/D),
     explanation, difficulty (easy/medium/hard), sourceContentId, sourceTimestamp, concept`;

const COMPETENCY_QUIZ_SYSTEM_PROMPT = `You are an expert educational assessment creator specializing in competency-based evaluation.

Generate assessment questions that measure specific competencies. Each question must:
1. Be tagged with the competency it measures
2. Use the appropriate question type for that competency
3. Include scenario/context when the assessment type calls for it
4. Have exactly 4 options (A, B, C, D)
5. Optionally allow text response for deeper evaluation (set allowTextResponse: true with a textPrompt)
6. Include a per-question timeLimit in seconds (default: 60, scenarios: 120, case studies: 180)

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

  async generateQuiz({ triggerId, userId, topic, contentIds, type, questionCount: requestedCount, objectiveId, assessmentType, isSkillAssessment }) {
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

    // Check if user has an active objective with competency analysis
    let competencyContext = null;
    let linkedCompetencies = [];
    // User's explicit choice always takes priority
    let effectiveAssessmentType = assessmentType || null;
    try {
      const objective = objectiveId
        ? await UserObjective.findById(objectiveId)
        : await UserObjective.findOne({ userId, status: 'active', isPrimary: true });

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

    let questions;
    try {
      // Scale max_tokens: ~500 tokens per question for regular, ~600 for competency (scenarios, text prompts)
      const tokensPerQuestion = competencyContext ? 600 : 500;
      const maxTokens = Math.max(4000, questionCount * tokensPerQuestion);

      console.log(`[QuizGeneration] Calling OpenAI for topic="${topic}", questionCount=${questionCount}, assessmentType=${effectiveAssessmentType || 'mixed'}, contentCount=${conceptData.length}, competencyAware=${!!competencyContext}, maxTokens=${maxTokens}`);

      const userPrompt = JSON.stringify(promptData);
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
          max_tokens: Math.max(3000, remaining * tokensPerQuestion),
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

    const quiz = await Quiz.create({
      userId, title: quizTitle, type: quizType, topic,
      sourceContentIds: contentIds || [],
      questions: sanitizedQuestions,
      totalQuestions: questions.length,
      assessmentType: effectiveAssessmentType || undefined,
      linkedCompetencies: linkedCompetencies.length > 0 ? linkedCompetencies : undefined,
      objectiveId: objectiveId || undefined,
      status: 'ready',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      generatedAt: new Date(),
    });

    if (triggerId) {
      await QuizTrigger.findByIdAndUpdate(triggerId, { quizId: quiz._id, status: 'generated' });
    }

    await notificationQueue.add('send', {
      userId, title: 'Quiz Ready!',
      body: `Test your ${topic} knowledge — ${quiz.totalQuestions} questions from your recent learning.`,
      data: { type: 'quiz_ready', quizId: quiz._id },
    });

    console.log(`[QuizGeneration] Quiz created: id=${quiz._id}, topic="${topic}", questions=${quiz.totalQuestions}, competencyAware=${!!competencyContext}`);
    return quiz;
  }
}

module.exports = new QuizGenerationService();
