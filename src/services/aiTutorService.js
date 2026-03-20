const openai = require('../config/openai');
const Content = require('../models/Content');
const Conversation = require('../models/Conversation');
const ApiError = require('../utils/apiError');
const { whisperTranscriptionQueue } = require('../config/queue');

// ──────────────────────────────────────────────
// System prompts
// ──────────────────────────────────────────────

const FULL_TUTOR_PROMPT = `You are an AI Tutor for ScaleUp, an educational platform. You help users understand content they are watching.

RULES:
- You have the full video transcript below. Use it to give SPECIFIC, ACCURATE answers grounded in what was actually said.
- When referencing something from the video, mention the approximate timestamp.
- If the user asks about a specific timestamp, focus on the transcript around that time.
- Break down complex concepts simply. Use analogies and real-world examples.
- Keep responses concise (2-4 paragraphs max) unless the user asks for more detail.
- If the user asks something NOT covered in the video, say so clearly and still provide a helpful answer.
- Use the key concepts and summary provided to give structured answers.
- Tone: friendly, encouraging, like a smart study buddy — not a lecturer.`;

const LIMITED_TUTOR_PROMPT = `You are an AI Tutor for ScaleUp, an educational platform. You help users understand content they are watching.

CONTEXT: You do NOT have the full transcript for this video. You only have the title, description, topic metadata, and AI-extracted key concepts/summary.

RULES:
- Answer based on the metadata and your general knowledge of the topic.
- Be honest about not having the full transcript — say "Based on the video's key concepts..." rather than pretending to quote the video.
- You CANNOT answer timestamp-specific questions. If asked, say: "I don't have the full transcript for this video, so I can't reference specific moments. But here's what I can tell you about that concept..."
- Keep responses concise and helpful.
- Tone: friendly, encouraging, like a smart study buddy.`;

// Quick prompt suggestions shown in the UI
const QUICK_PROMPTS = [
  { id: 'summarize', label: 'Summarize this video', prompt: 'Give me a concise summary of this video.' },
  { id: 'simpler', label: 'Explain this simpler', prompt: 'Can you explain the main concepts of this video in simpler terms?' },
  { id: 'example', label: 'Give me an example', prompt: 'Can you give me a real-world example of the main concept discussed in this video?' },
  { id: 'prerequisites', label: 'What should I know first?', prompt: 'What prerequisite knowledge do I need before watching this video?' },
  { id: 'quiz_me', label: 'Quiz me on this', prompt: 'Ask me 3 quick questions to test my understanding of this video.' },
  { id: 'key_takeaways', label: 'Key takeaways', prompt: 'What are the top 3 key takeaways from this video?' },
];

class AiTutorService {

  // ──────────────────────────────────────────────
  // Get or create a conversation for a content item
  // ──────────────────────────────────────────────

  async getConversation(userId, contentId) {
    const content = await Content.findById(contentId);
    if (!content) throw new ApiError(404, 'Content not found');

    let conversation = await Conversation.findOne({ userId, contentId });

    if (!conversation) {
      // Determine tutor tier
      const hasTranscript = content.transcript && content.transcript.trim().length > 0;
      const tier = hasTranscript ? 'full' : 'limited';

      conversation = await Conversation.create({
        userId,
        contentId,
        contentTitle: content.title,
        contentDomain: content.domain,
        tutorTier: tier,
        messages: [],
        messageCount: 0,
      });

      // If no transcript, queue Whisper job (async — doesn't block the user)
      if (!hasTranscript && content.youtubeVideoId) {
        try {
          await whisperTranscriptionQueue.add('transcribe', {
            contentId: content._id.toString(),
          }, {
            attempts: 2,
            backoff: { type: 'exponential', delay: 30000 },
            priority: 5,
          });
        } catch { /* Queue failure shouldn't block chat */ }
      }
    }

    return {
      conversationId: conversation._id,
      contentId: conversation.contentId,
      contentTitle: conversation.contentTitle,
      tutorTier: conversation.tutorTier,
      messages: conversation.messages,
      messageCount: conversation.messageCount,
      quickPrompts: QUICK_PROMPTS,
    };
  }

  // ──────────────────────────────────────────────
  // Send a message and get AI response
  // ──────────────────────────────────────────────

  async sendMessage(userId, contentId, userMessage) {
    if (!userMessage || userMessage.trim().length === 0) {
      throw new ApiError(400, 'Message cannot be empty');
    }
    if (userMessage.length > 2000) {
      throw new ApiError(400, 'Message too long (max 2000 characters)');
    }

    const content = await Content.findById(contentId);
    if (!content) throw new ApiError(404, 'Content not found');

    // Get or create conversation
    let conversation = await Conversation.findOne({ userId, contentId });
    if (!conversation) {
      const hasTranscript = content.transcript && content.transcript.trim().length > 0;
      conversation = await Conversation.create({
        userId,
        contentId,
        contentTitle: content.title,
        contentDomain: content.domain,
        tutorTier: hasTranscript ? 'full' : 'limited',
        messages: [],
        messageCount: 0,
      });
    }

    // Check if transcript appeared since conversation was created (Whisper may have completed)
    if (conversation.tutorTier === 'limited' && content.transcript && content.transcript.trim().length > 0) {
      conversation.tutorTier = 'full';
    }

    const isFull = conversation.tutorTier === 'full';

    // Build context for GPT
    const systemPrompt = isFull ? FULL_TUTOR_PROMPT : LIMITED_TUTOR_PROMPT;
    const contentContext = this._buildContentContext(content, isFull);

    // Build message history (last 20 messages for context window management)
    const recentMessages = conversation.messages.slice(-20);
    const chatHistory = recentMessages.map(m => ({
      role: m.role,
      content: m.content,
    }));

    // Extract timestamp from user message for focused context
    const timestampContext = isFull ? this._extractTimestampContext(userMessage, content.transcript) : '';

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'system', content: contentContext },
    ];

    if (timestampContext) {
      messages.push({ role: 'system', content: `FOCUSED TRANSCRIPT CONTEXT (around the timestamp the user asked about):\n${timestampContext}` });
    }

    messages.push(...chatHistory);
    messages.push({ role: 'user', content: userMessage });

    // Call GPT-4o
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
      temperature: 0.5,
      max_tokens: 1000,
    });

    const assistantMessage = response.choices[0].message.content;

    // Determine which concepts were referenced
    const conceptsReferenced = this._findReferencedConcepts(assistantMessage, content.aiData?.keyConcepts || []);

    // Save both messages
    conversation.messages.push({
      role: 'user',
      content: userMessage,
    });
    conversation.messages.push({
      role: 'assistant',
      content: assistantMessage,
      contextMeta: {
        conceptsReferenced,
        tutorTier: conversation.tutorTier,
      },
    });
    conversation.messageCount += 2;
    conversation.lastMessageAt = new Date();
    await conversation.save();

    return {
      message: {
        role: 'assistant',
        content: assistantMessage,
        contextMeta: {
          conceptsReferenced,
          tutorTier: conversation.tutorTier,
        },
        createdAt: new Date(),
      },
      tutorTier: conversation.tutorTier,
      messageCount: conversation.messageCount,
    };
  }

  // ──────────────────────────────────────────────
  // Get all conversations for a user (history list)
  // ──────────────────────────────────────────────

  async listConversations(userId, { page = 1, limit = 20 } = {}) {
    const skip = (page - 1) * limit;

    const [conversations, total] = await Promise.all([
      Conversation.find({ userId, messageCount: { $gt: 0 } })
        .select('contentId contentTitle contentDomain tutorTier messageCount lastMessageAt')
        .sort({ lastMessageAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Conversation.countDocuments({ userId, messageCount: { $gt: 0 } }),
    ]);

    // Attach last message preview
    const withPreviews = await Promise.all(conversations.map(async (conv) => {
      const full = await Conversation.findById(conv._id).select('messages').lean();
      const lastMsg = full.messages?.[full.messages.length - 1];
      return {
        ...conv,
        lastMessage: lastMsg ? {
          role: lastMsg.role,
          preview: lastMsg.content.slice(0, 100) + (lastMsg.content.length > 100 ? '...' : ''),
        } : null,
      };
    }));

    const totalPages = Math.ceil(total / limit);
    return {
      items: withPreviews,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  // ──────────────────────────────────────────────
  // Delete conversation
  // ──────────────────────────────────────────────

  async deleteConversation(userId, contentId) {
    const result = await Conversation.findOneAndDelete({ userId, contentId });
    if (!result) throw new ApiError(404, 'Conversation not found');
    return { deleted: true };
  }

  // ──────────────────────────────────────────────
  // Check tutor availability for a content item
  // ──────────────────────────────────────────────

  async getTutorStatus(contentId) {
    const content = await Content.findById(contentId)
      .select('transcript aiStatus aiData title domain')
      .lean();
    if (!content) throw new ApiError(404, 'Content not found');

    const hasTranscript = content.transcript && content.transcript.trim().length > 0;
    const hasAiData = content.aiStatus === 'completed' && content.aiData;

    let tier = 'disabled';
    if (hasTranscript) tier = 'full';
    else if (hasAiData) tier = 'limited';

    return {
      tier,
      hasTranscript,
      hasAiData: !!hasAiData,
      quickPrompts: tier !== 'disabled' ? QUICK_PROMPTS : [],
    };
  }

  // ──────────────────────────────────────────────
  // Private: Build content context for GPT
  // ──────────────────────────────────────────────

  _buildContentContext(content, isFull) {
    let ctx = `VIDEO DETAILS:\n`;
    ctx += `Title: ${content.title}\n`;
    ctx += `Domain: ${content.domain}\n`;
    ctx += `Topics: ${(content.topics || []).join(', ')}\n`;
    ctx += `Difficulty: ${content.difficulty || 'intermediate'}\n`;
    if (content.duration) ctx += `Duration: ${Math.floor(content.duration / 60)}:${String(content.duration % 60).padStart(2, '0')}\n`;

    // AI-extracted data
    if (content.aiData) {
      if (content.aiData.summary) {
        ctx += `\nSUMMARY:\n${content.aiData.summary}\n`;
      }
      if (content.aiData.keyConcepts?.length > 0) {
        ctx += `\nKEY CONCEPTS:\n`;
        for (const kc of content.aiData.keyConcepts) {
          ctx += `- ${kc.concept}${kc.timestamp ? ` (at ${kc.timestamp})` : ''}: ${kc.description || ''}\n`;
        }
      }
      if (content.aiData.prerequisites?.length > 0) {
        ctx += `\nPREREQUISITES: ${content.aiData.prerequisites.join(', ')}\n`;
      }
    }

    // Full transcript (trimmed to 12k chars to leave room for chat history)
    if (isFull && content.transcript) {
      ctx += `\nFULL TRANSCRIPT:\n${content.transcript.slice(0, 12000)}\n`;
      if (content.transcript.length > 12000) {
        ctx += `[... transcript truncated at 12000 chars, ${content.transcript.length} total ...]\n`;
      }
    }

    return ctx;
  }

  // ──────────────────────────────────────────────
  // Private: Extract transcript around a timestamp
  // ──────────────────────────────────────────────

  _extractTimestampContext(userMessage, transcript) {
    if (!transcript) return '';

    // Match patterns like "4:32", "at 4:32", "around 12:05", "04:32"
    const tsMatch = userMessage.match(/\b(\d{1,2}):(\d{2})\b/);
    if (!tsMatch) return '';

    const minutes = parseInt(tsMatch[1]);
    const seconds = parseInt(tsMatch[2]);
    const totalSeconds = minutes * 60 + seconds;

    // Estimate character position (rough: ~2.5 words/sec, ~6 chars/word = ~15 chars/sec)
    const charsPerSecond = 15;
    const centerPos = totalSeconds * charsPerSecond;
    const windowChars = 1500; // ~100 seconds of transcript

    const start = Math.max(0, centerPos - windowChars / 2);
    const end = Math.min(transcript.length, centerPos + windowChars / 2);

    const segment = transcript.slice(start, end);
    if (segment.length < 50) return ''; // Too short to be useful

    return `[Around ${minutes}:${String(seconds).padStart(2, '0')}]\n${segment}`;
  }

  // ──────────────────────────────────────────────
  // Private: Find which keyConcepts the AI referenced
  // ──────────────────────────────────────────────

  _findReferencedConcepts(response, keyConcepts) {
    const referenced = [];
    const lowerResponse = response.toLowerCase();

    for (const kc of keyConcepts) {
      if (lowerResponse.includes(kc.concept.toLowerCase())) {
        referenced.push(kc.concept);
      }
    }
    return referenced;
  }
}

module.exports = new AiTutorService();
