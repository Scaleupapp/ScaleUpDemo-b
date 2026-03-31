const openai = require('../config/openai');
const Content = require('../models/Content');
const FlashcardSet = require('../models/FlashcardSet');
const ApiError = require('../utils/apiError');

const FLASHCARD_PROMPT = `You are an expert study assistant. Generate flashcards from the provided educational content.

RULES:
- Create 10-20 flashcards depending on content length and depth.
- Each card has a "front" (question/term) and "back" (answer/definition).
- Optionally include a "hint" for difficult concepts.
- Set difficulty: "easy" for definitions, "medium" for applications, "hard" for analysis.
- Include the concept name if applicable.
- Make flashcards useful for exam preparation — focus on key facts, formulas, processes, and distinctions.
- Vary question types: definitions, fill-in-the-blank style, cause-effect, compare-contrast.

Return valid JSON with this structure:
{
  "cards": [
    { "front": "...", "back": "...", "hint": "...", "difficulty": "easy|medium|hard", "concept": "..." }
  ]
}`;

class FlashcardGenerationService {

  async generate(userId, contentId) {
    const content = await Content.findById(contentId);
    if (!content) throw new ApiError(404, 'Content not found');

    // Check if flashcard set already exists for this user + content
    const existing = await FlashcardSet.findOne({ userId, contentId, status: 'ready' });
    if (existing) return existing;

    // Get content text
    const contentText = content.ocrText || content.transcript || content.description || '';
    if (contentText.length < 50) throw new ApiError(400, 'Content has insufficient text for flashcard generation');

    // Get key concepts if available
    const keyConcepts = content.aiData?.keyConcepts?.map(kc => `${kc.concept}: ${kc.description || ''}`).join('\n') || '';

    // Create placeholder
    const flashcardSet = await FlashcardSet.create({
      userId,
      contentId,
      title: `Flashcards: ${content.title}`,
      cards: [],
      totalCards: 0,
      status: 'generating',
    });

    try {
      const inputText = contentText.slice(0, 10000); // Limit input
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: FLASHCARD_PROMPT },
          {
            role: 'user',
            content: `CONTENT TITLE: ${content.title}\nTOPIC: ${content.domain}\n\nKEY CONCEPTS:\n${keyConcepts}\n\nFULL TEXT:\n${inputText}`,
          },
        ],
        temperature: 0.5,
        max_tokens: 3000,
        response_format: { type: 'json_object' },
      });

      const parsed = JSON.parse(response.choices[0].message.content);
      const cards = (parsed.cards || []).map(c => ({
        front: c.front,
        back: c.back,
        hint: c.hint || undefined,
        difficulty: ['easy', 'medium', 'hard'].includes(c.difficulty) ? c.difficulty : 'medium',
        concept: c.concept || undefined,
      }));

      flashcardSet.cards = cards;
      flashcardSet.totalCards = cards.length;
      flashcardSet.status = 'ready';
      flashcardSet.generatedAt = new Date();
      await flashcardSet.save();

      return flashcardSet;
    } catch (err) {
      flashcardSet.status = 'failed';
      await flashcardSet.save();
      throw err;
    }
  }

  async getUserFlashcards(userId, { page = 1, limit = 20 } = {}) {
    const skip = (page - 1) * limit;
    const [sets, total] = await Promise.all([
      FlashcardSet.find({ userId, status: 'ready' })
        .populate('contentId', 'title domain contentType thumbnailURL')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      FlashcardSet.countDocuments({ userId, status: 'ready' }),
    ]);
    return { items: sets, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async getFlashcardSet(userId, flashcardSetId) {
    const set = await FlashcardSet.findOne({ _id: flashcardSetId, userId })
      .populate('contentId', 'title domain contentType')
      .lean();
    if (!set) throw new ApiError(404, 'Flashcard set not found');
    return set;
  }

  async recordStudySession(userId, flashcardSetId, { masteredCount } = {}) {
    const set = await FlashcardSet.findOne({ _id: flashcardSetId, userId });
    if (!set) throw new ApiError(404, 'Flashcard set not found');

    set.lastStudiedAt = new Date();
    set.timesStudied += 1;
    if (masteredCount !== undefined) set.masteredCount = masteredCount;
    await set.save();
    return set;
  }

  async deleteFlashcardSet(userId, flashcardSetId) {
    const result = await FlashcardSet.findOneAndDelete({ _id: flashcardSetId, userId });
    if (!result) throw new ApiError(404, 'Flashcard set not found');
    return { deleted: true };
  }
}

module.exports = new FlashcardGenerationService();
