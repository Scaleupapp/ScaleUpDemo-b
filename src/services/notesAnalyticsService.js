const Content = require('../models/Content');
const ContentProgress = require('../models/ContentProgress');
const ApiError = require('../utils/apiError');

class NotesAnalyticsService {

  async getContributorAnalytics(userId) {
    // Get all user's notes
    const notes = await Content.find({
      creatorId: userId,
      contentType: 'notes',
    }).select('_id title viewCount likeCount saveCount domain aiData.qualityScore publishedAt status').lean();

    if (notes.length === 0) {
      return {
        overview: { totalNotes: 0, totalViews: 0, totalSaves: 0, totalLikes: 0, avgQualityScore: 0, saveToViewRatio: 0 },
        viewsOverTime: [],
        topNotes: [],
        domainBreakdown: [],
      };
    }

    const noteIds = notes.map(n => n._id);

    // Overview
    const totalNotes = notes.length;
    const totalViews = notes.reduce((s, n) => s + (n.viewCount || 0), 0);
    const totalSaves = notes.reduce((s, n) => s + (n.saveCount || 0), 0);
    const totalLikes = notes.reduce((s, n) => s + (n.likeCount || 0), 0);
    const qualityScores = notes.filter(n => n.aiData?.qualityScore).map(n => n.aiData.qualityScore);
    const avgQualityScore = qualityScores.length > 0
      ? Math.round(qualityScores.reduce((s, q) => s + q, 0) / qualityScores.length)
      : 0;
    const saveToViewRatio = totalViews > 0 ? Math.round((totalSaves / totalViews) * 1000) / 1000 : 0;

    // Views over time (last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
    const viewsOverTime = await ContentProgress.aggregate([
      {
        $match: {
          contentId: { $in: noteIds },
          firstViewedAt: { $gte: thirtyDaysAgo },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$firstViewedAt' } },
          views: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Top 5 performing notes
    const topNotes = [...notes]
      .filter(n => n.status === 'published')
      .sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0))
      .slice(0, 5)
      .map(n => ({
        _id: n._id,
        title: n.title,
        viewCount: n.viewCount || 0,
        likeCount: n.likeCount || 0,
        saveCount: n.saveCount || 0,
      }));

    // Domain breakdown
    const domainMap = {};
    for (const note of notes) {
      const d = note.domain || 'general';
      if (!domainMap[d]) domainMap[d] = { domain: d, noteCount: 0, totalViews: 0 };
      domainMap[d].noteCount += 1;
      domainMap[d].totalViews += note.viewCount || 0;
    }
    const domainBreakdown = Object.values(domainMap).sort((a, b) => b.totalViews - a.totalViews);

    return {
      overview: { totalNotes, totalViews, totalSaves, totalLikes, avgQualityScore, saveToViewRatio },
      viewsOverTime: viewsOverTime.map(v => ({ date: v._id, views: v.views })),
      topNotes,
      domainBreakdown,
    };
  }

  async getNoteAnalytics(userId, contentId) {
    const note = await Content.findOne({ _id: contentId, creatorId: userId, contentType: 'notes' })
      .select('title viewCount likeCount saveCount commentCount domain aiData publishedAt')
      .lean();
    if (!note) throw new ApiError(404, 'Note not found');

    // Views over time for this note
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
    const viewsOverTime = await ContentProgress.aggregate([
      {
        $match: {
          contentId: note._id,
          firstViewedAt: { $gte: thirtyDaysAgo },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$firstViewedAt' } },
          views: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Unique viewers count
    const uniqueViewers = await ContentProgress.countDocuments({ contentId: note._id });

    return {
      ...note,
      uniqueViewers,
      viewsOverTime: viewsOverTime.map(v => ({ date: v._id, views: v.views })),
    };
  }
}

module.exports = new NotesAnalyticsService();
