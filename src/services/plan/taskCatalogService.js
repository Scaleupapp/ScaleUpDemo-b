const Quiz = require('../../models/Quiz');
const Content = require('../../models/Content');
const { canonicalize } = require('../diagnostic/topicTaxonomyService');

const DEFAULT_QUIZ_MINUTES = 8;
const DEFAULT_CONTENT_MINUTES = 12;

async function resolveTopic({ topicCanonicalName, objectiveType, objectiveId, userId }) {
  const key = canonicalize(topicCanonicalName);
  if (!key) return { quizId: null, contentId: null };

  let quiz = await Quiz.findOne({ topic: key, objectiveId }).sort({ createdAt: -1 }).lean();
  if (!quiz) {
    quiz = await Quiz.findOne({ topic: key }).sort({ createdAt: -1 }).lean();
  }

  // Phase 7: lazy quiz generation. If no quiz exists for this topic+objective,
  // synchronously generate one via the existing quizGenerationService. Plan
  // generation is async via the worker, so the latency hit is invisible to
  // the user. 15s hard timeout falls back to no-quiz (manual task takes over).
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
        }),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('lazy_gen_timeout')), 15000);
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
