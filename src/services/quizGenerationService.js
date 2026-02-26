const mongoose = require('mongoose');
const openai = require('../config/openai');
const Content = require('../models/Content');
const Quiz = require('../models/Quiz');
const QuizTrigger = require('../models/QuizTrigger');
const KnowledgeProfile = require('../models/KnowledgeProfile');
const { notificationQueue } = require('../config/queue');
const { DIFFICULTY_MIX } = require('../utils/constants');

const QUIZ_SYSTEM_PROMPT = `You are an expert educational assessment creator.
Generate a quiz based on the provided content. Rules:
1. Each question must directly test understanding of the provided content
2. Include the sourceContentId and sourceTimestamp for each question
3. Mix question types: conceptual, application, cross_content, recall, critical_thinking
4. Provide clear explanations for correct answers
5. Each question must have exactly 4 options (A, B, C, D)
6. Return valid JSON with a "questions" array where each question has:
   - questionText, questionType, options (array of {label, text}), correctAnswer (A/B/C/D),
     explanation, difficulty (easy/medium/hard), sourceContentId, sourceTimestamp, concept`;

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

  async generateQuiz({ triggerId, userId, topic, contentIds, type }) {
    const quizType = TRIGGER_TO_QUIZ_TYPE[type] || 'topic_consolidation';

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

    const questionCount = quizType === 'retention_check' ? 5 :
                          quizType === 'weekly_review' ? 12 :
                          quizType === 'milestone_assessment' ? 15 : 10;

    // Build the user prompt — include content data if available, otherwise just the topic
    const userPrompt = conceptData.length > 0
      ? JSON.stringify({ topic, userLevel: level, difficultyMix, questionCount, contents: conceptData })
      : JSON.stringify({ topic, userLevel: level, difficultyMix, questionCount, contents: [], note: `Generate questions about "${topic}" based on general knowledge. No specific source content available.` });

    let questions;
    try {
      console.log(`[QuizGeneration] Calling OpenAI for topic="${topic}", questionCount=${questionCount}, contentCount=${conceptData.length}`);

      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: QUIZ_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.7,
        max_tokens: 4000,
      });

      const parsed = JSON.parse(response.choices[0].message.content);
      questions = parsed.questions;

      if (!questions || !Array.isArray(questions) || questions.length === 0) {
        throw new Error(`OpenAI returned invalid quiz data: no questions array`);
      }

      console.log(`[QuizGeneration] OpenAI returned ${questions.length} questions for topic="${topic}"`);
    } catch (err) {
      console.error(`[QuizGeneration] OpenAI call failed for topic="${topic}":`, err.message);

      // Update trigger status to failed so frontend can detect the failure
      if (triggerId) {
        await QuizTrigger.findByIdAndUpdate(triggerId, { status: 'failed' });
      }

      throw err; // Re-throw so BullMQ marks the job as failed
    }

    // Sanitize questions: strip invalid ObjectId values that OpenAI may hallucinate
    const validContentIds = new Set((contentIds || []).map(id => id.toString()));
    const sanitizedQuestions = questions.map(q => {
      const clean = { ...q };
      // Remove sourceContentId if it's not a valid ObjectId or not in our content set
      if (clean.sourceContentId) {
        const isValidObjectId = mongoose.Types.ObjectId.isValid(clean.sourceContentId);
        if (!isValidObjectId || (validContentIds.size > 0 && !validContentIds.has(clean.sourceContentId))) {
          delete clean.sourceContentId;
        }
      }
      return clean;
    });

    const quiz = await Quiz.create({
      userId, title: `${topic} — Knowledge Check`, type: quizType, topic,
      sourceContentIds: contentIds || [],
      questions: sanitizedQuestions,
      totalQuestions: questions.length,
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

    console.log(`[QuizGeneration] Quiz created: id=${quiz._id}, topic="${topic}", questions=${quiz.totalQuestions}`);
    return quiz;
  }
}

module.exports = new QuizGenerationService();
