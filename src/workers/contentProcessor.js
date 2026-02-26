const openai = require('../config/openai');
const Content = require('../models/Content');

const CONTENT_ANALYSIS_PROMPT = `You are an educational content analyzer. Analyze the following content and extract:

1. summary: A 2-3 sentence summary (max 500 chars)
2. keyConcepts: Array of key concepts, each with:
   - concept: The concept name
   - description: Brief explanation
   - timestamp: Where in the content this appears ("MM:SS" for video, "Para X" for text)
   - importance: 1-5 rating
3. prerequisites: Array of topics the viewer should already know
4. qualityScore: 0-100 rating of content quality (clarity, accuracy, depth)
5. autoTags: Array of relevant tags for discoverability
6. difficulty: "beginner", "intermediate", or "advanced"
7. moderationFlags: Array of any content concerns (empty if none)

Return valid JSON only.`;

async function processContent(job) {
  const { contentId } = job.data;
  const content = await Content.findById(contentId);
  if (!content) return;

  content.aiStatus = 'processing';
  await content.save();

  try {
    const contentText = content.transcript || content.description || '';

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: CONTENT_ANALYSIS_PROMPT },
        { role: 'user', content: `Title: ${content.title}\nDomain: ${content.domain}\nTopics: ${content.topics.join(', ')}\nContent:\n${contentText.slice(0, 15000)}` },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    });

    const analysis = JSON.parse(response.choices[0].message.content);

    content.aiData = {
      summary: analysis.summary,
      keyConcepts: analysis.keyConcepts || [],
      prerequisites: analysis.prerequisites || [],
      qualityScore: analysis.qualityScore,
      autoTags: analysis.autoTags || [],
      moderationFlags: analysis.moderationFlags || [],
      processedAt: new Date(),
    };
    content.aiStatus = 'completed';
    content.difficulty = analysis.difficulty || content.difficulty;

    // Auto-publish YouTube content if it passes quality + moderation checks.
    // Original creator content stays at 'ready' — creator must manually publish.
    const hasHighSeverityFlags = (analysis.moderationFlags || []).some(f => f.severity === 'high');
    const passesQuality = (analysis.qualityScore || 0) >= 40;

    if (content.isYoutubeImport && passesQuality && !hasHighSeverityFlags) {
      content.status = 'published';
      content.publishedAt = new Date();
      content.moderationStatus = 'approved';
    } else if (content.isYoutubeImport && !passesQuality) {
      // Low quality YouTube content — don't publish, don't show
      content.status = 'rejected';
      content.moderationStatus = 'rejected';
      content.moderationNote = `Auto-rejected: quality score ${analysis.qualityScore}/100`;
    } else if (content.isYoutubeImport && hasHighSeverityFlags) {
      content.status = 'ready';
      content.moderationStatus = 'flagged';
    } else {
      // Original creator content — stays at 'ready' for manual publish
      content.status = 'ready';
    }

    await content.save();
  } catch (err) {
    content.aiStatus = 'failed';
    await content.save();
    throw err;
  }
}

module.exports = processContent;
