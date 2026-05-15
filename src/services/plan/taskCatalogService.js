const Quiz = require('../../models/Quiz');
const Content = require('../../models/Content');
const { canonicalize } = require('../diagnostic/topicTaxonomyService');

const DEFAULT_QUIZ_MINUTES = 8;
const DEFAULT_CONTENT_MINUTES = 12;

async function resolveTopic({ topicCanonicalName, objectiveType, objectiveId, userId }) {
  const key = canonicalize(topicCanonicalName);
  if (!key) return { quizId: null, contentId: null };

  // Quizzes are user-scoped — GET /quizzes/:id does Quiz.findOne({ _id, userId }).
  // So the plan must only ever reference quizzes THIS user owns; otherwise the
  // task opens to "Quiz not found". Previously this matched any user's quiz by
  // {topic, objectiveId} (or globally by topic), which is exactly that bug.
  let quiz = null;
  if (userId) {
    quiz = await Quiz.findOne({ topic: key, objectiveId, userId }).sort({ createdAt: -1 }).lean();
    if (!quiz) {
      quiz = await Quiz.findOne({ topic: key, userId }).sort({ createdAt: -1 }).lean();
    }
  }
  // No user-owned quiz → fall through to lazy generation below.

  // Phase 7: lazy quiz generation. If no quiz exists for this topic+objective,
  // synchronously generate one via the existing quizGenerationService.
  //
  // Timeout was 15s, but quiz LLM gen averages 20-40s, so every call timed out
  // and we wasted 15s × N topics producing nothing. Raised to 60s so successes
  // actually persist + get cached for adjacent weeks. `suppressNotification`
  // stops the per-quiz "Quiz Ready!" push from firing during bulk plan-gen
  // (the plan-ready push covers the batch).
  if (!quiz && objectiveId && userId) {
    let timeoutHandle;
    try {
      const quizGenerationService = require('../quizGenerationService');
      const generated = await Promise.race([
        quizGenerationService.generateQuiz({
          userId,
          objectiveId,
          topic: key,
          contentIds: [],
          type: 'plan_seed',
          questionCount: 5,
          suppressNotification: true,
        }),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('lazy_gen_timeout')), 60000);
        }),
      ]);
      if (generated && generated._id) {
        quiz = generated;
      }
    } catch (err) {
      console.warn('[taskCatalogService] lazy quiz gen failed for topic', key, ':', err.message);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  const content = await Content.findOne({ topics: key, status: 'published' })
    .sort({ publishedAt: -1 })
    .lean();

  return {
    quizId: quiz ? String(quiz._id) : null,
    quizMinutes: quiz ? (quiz.estimatedMinutes || DEFAULT_QUIZ_MINUTES) : null,
    contentId: content ? String(content._id) : null,
    contentType: content ? content.contentType : null,
    contentMinutes: content ? (content.duration || DEFAULT_CONTENT_MINUTES) : null,
  };
}

module.exports = { resolveTopic, _internal: { DEFAULT_QUIZ_MINUTES, DEFAULT_CONTENT_MINUTES } };
