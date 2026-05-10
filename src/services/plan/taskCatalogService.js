const Quiz = require('../../models/Quiz');
const Content = require('../../models/Content');
const { canonicalize } = require('../diagnostic/topicTaxonomyService');

const DEFAULT_QUIZ_MINUTES = 8;
const DEFAULT_CONTENT_MINUTES = 12;

async function resolveTopic({ topicCanonicalName, objectiveType, objectiveId }) {
  const key = canonicalize(topicCanonicalName);
  if (!key) return { quizId: null, contentId: null };

  let quiz = await Quiz.findOne({ topic: key, objectiveId }).sort({ createdAt: -1 }).lean();
  if (!quiz) {
    quiz = await Quiz.findOne({ topic: key }).sort({ createdAt: -1 }).lean();
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
