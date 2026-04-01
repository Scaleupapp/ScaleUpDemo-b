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
    const contentText = content.ocrText || content.transcript || content.description || '';

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
    } else if (content.contentType === 'notes') {
      // Notes approval flow
      if (hasHighSeverityFlags) {
        content.status = 'rejected';
        content.moderationStatus = 'rejected';
        content.moderationNote = 'Auto-rejected: content flagged for moderation concerns';
      } else if (!passesQuality) {
        content.status = 'rejected';
        content.moderationStatus = 'rejected';
        content.moderationNote = `Auto-rejected: quality score ${analysis.qualityScore}/100`;
      } else {
        // Check if contributor has 3+ approved notes → auto-publish, else → pending review
        const Content = require('../models/Content');
        const approvedCount = await Content.countDocuments({
          creatorId: content.creatorId,
          contentType: 'notes',
          moderationStatus: 'approved',
          _id: { $ne: content._id },
        });

        if (approvedCount >= 3) {
          // Trusted contributor — auto-publish
          content.status = 'published';
          content.publishedAt = new Date();
          content.moderationStatus = 'approved';
        } else {
          // New contributor — needs admin review
          content.status = 'ready';
          content.moderationStatus = 'pending';
        }
      }
    } else {
      // Original creator content — stays at 'ready' for manual publish
      content.status = 'ready';
    }

    await content.save();

    // Notifications for notes
    if (content.contentType === 'notes' && content.creatorId) {
      const { notificationQueue } = require('../config/queue');
      try {
        if (content.moderationStatus === 'pending') {
          // Notify user: under review
          await notificationQueue.add('send', {
            userId: content.creatorId.toString(),
            title: 'Notes submitted for review',
            body: `"${content.title}" is being reviewed. We'll notify you once approved.`,
            data: { type: 'notes_pending_review', contentId: content._id.toString() },
          });
          // Notify admins
          const User = require('../models/User');
          const admins = await User.find({ role: 'admin' }).select('_id').lean();
          for (const admin of admins) {
            await notificationQueue.add('send', {
              userId: admin._id.toString(),
              title: 'New notes to review',
              body: `A contributor uploaded "${content.title}". Please review.`,
              data: { type: 'admin_notes_review', contentId: content._id.toString() },
            });
          }
        } else if (content.status === 'published') {
          await notificationQueue.add('send', {
            userId: content.creatorId.toString(),
            title: 'Your notes are live!',
            body: `"${content.title}" has been published and is now visible to everyone.`,
            data: { type: 'notes_published', contentId: content._id.toString() },
          });
        } else if (content.moderationStatus === 'rejected') {
          await notificationQueue.add('send', {
            userId: content.creatorId.toString(),
            title: 'Notes not approved',
            body: `"${content.title}" didn't meet our quality standards. ${content.moderationNote || ''}`,
            data: { type: 'notes_rejected', contentId: content._id.toString() },
          });
        }
      } catch {}
    }
  } catch (err) {
    content.aiStatus = 'failed';
    await content.save();
    throw err;
  }
}

module.exports = processContent;
