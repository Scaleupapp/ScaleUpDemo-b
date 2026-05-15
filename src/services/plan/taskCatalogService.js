const Quiz = require('../../models/Quiz');
const Content = require('../../models/Content');
const UserObjective = require('../../models/UserObjective');
const { canonicalize } = require('../diagnostic/topicTaxonomyService');

const DEFAULT_QUIZ_MINUTES = 8;
const DEFAULT_CONTENT_MINUTES = 12;

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve a published Content item for a plan topic.
 *
 * Content.topics is tagged with broad display phrases ("mba preparation")
 * while plan topics are fine-grained canonical slugs ("critical-reasoning"),
 * so an exact `topics: key` match almost never hits. We therefore:
 *   1. try the exact canonical topic,
 *   2. fall back to a fuzzy slug match across the candidate's topics,
 *   3. fall back to the objective's own terms (exam / role / skill / domain)
 *      across title + topics + domain — which is what actually surfaces the
 *      GMAT content for a GMAT objective.
 */
async function resolveContentForTopic(key, objectiveId) {
  let content = await Content.findOne({ topics: key, status: 'published' })
    .sort({ publishedAt: -1 })
    .lean();
  if (content) return content;

  // Fuzzy: a topic phrase whose slug equals (or contains) the key.
  const keyRx = new RegExp(escapeRegex(key.replace(/-/g, '[ -]?')), 'i');
  content = await Content.findOne({ status: 'published', topics: keyRx })
    .sort({ publishedAt: -1 })
    .lean();
  if (content) return content;

  // Objective-term fallback — surfaces objective-relevant content even when
  // it isn't tagged with the granular topic.
  if (objectiveId) {
    try {
      const obj = await UserObjective.findById(objectiveId)
        .select('specifics')
        .lean();
      const terms = [
        obj?.specifics?.examName,
        obj?.specifics?.targetRole,
        obj?.specifics?.targetSkill,
        obj?.specifics?.toDomain,
      ].filter(Boolean);
      if (terms.length) {
        const rx = new RegExp(terms.map(escapeRegex).join('|'), 'i');
        content = await Content.findOne({
          status: 'published',
          $or: [{ title: rx }, { topics: rx }, { domain: rx }],
        })
          .sort({ publishedAt: -1 })
          .lean();
      }
    } catch (err) {
      console.warn('[taskCatalogService] objective content fallback failed:', err.message);
    }
  }
  return content;
}

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

  const content = await resolveContentForTopic(key, objectiveId);

  return {
    quizId: quiz ? String(quiz._id) : null,
    quizMinutes: quiz ? (quiz.estimatedMinutes || DEFAULT_QUIZ_MINUTES) : null,
    contentId: content ? String(content._id) : null,
    contentType: content ? content.contentType : null,
    contentMinutes: content ? (content.duration || DEFAULT_CONTENT_MINUTES) : null,
  };
}

module.exports = { resolveTopic, _internal: { DEFAULT_QUIZ_MINUTES, DEFAULT_CONTENT_MINUTES } };
