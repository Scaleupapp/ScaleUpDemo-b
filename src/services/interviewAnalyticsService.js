const InterviewSession = require('../models/InterviewSession');

class InterviewAnalyticsService {
  async getAnalytics(userId) {
    const sessions = await InterviewSession.find({
      userId,
      status: 'evaluated',
    }).select('interviewType evaluation.overallScore evaluation.communication.score evaluation.content.score evaluation.structure.score evaluation.confidence.score startedAt createdAt').lean();

    if (sessions.length === 0) {
      return {
        totalInterviews: 0,
        averageScore: 0,
        scoreTrend: [],
        dimensionAverages: { communication: 0, content: 0, structure: 0, confidence: 0 },
        weakestDimension: null,
        interviewsThisWeek: 0,
        interviewsThisMonth: 0,
        typeBreakdown: [],
      };
    }

    // Total + averages
    const totalInterviews = sessions.length;
    const scores = sessions.map(s => s.evaluation?.overallScore).filter(Boolean);
    const averageScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);

    // Score trend (last 10)
    const scoreTrend = sessions
      .filter(s => s.evaluation?.overallScore)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      .slice(-10)
      .map(s => ({ date: s.createdAt, score: s.evaluation.overallScore, type: s.interviewType }));

    // Dimension averages
    const dims = { communication: [], content: [], structure: [], confidence: [] };
    for (const s of sessions) {
      if (s.evaluation?.communication?.score) dims.communication.push(s.evaluation.communication.score);
      if (s.evaluation?.content?.score) dims.content.push(s.evaluation.content.score);
      if (s.evaluation?.structure?.score) dims.structure.push(s.evaluation.structure.score);
      if (s.evaluation?.confidence?.score) dims.confidence.push(s.evaluation.confidence.score);
    }
    const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 10) / 10 : 0;
    const dimensionAverages = {
      communication: avg(dims.communication),
      content: avg(dims.content),
      structure: avg(dims.structure),
      confidence: avg(dims.confidence),
    };

    // Weakest dimension
    const dimEntries = Object.entries(dimensionAverages).filter(([_, v]) => v > 0);
    const weakestDimension = dimEntries.length ? dimEntries.sort((a, b) => a[1] - b[1])[0][0] : null;

    // This week / month
    const now = new Date();
    const weekAgo = new Date(now - 7 * 86400000);
    const monthAgo = new Date(now - 30 * 86400000);
    const interviewsThisWeek = sessions.filter(s => new Date(s.createdAt) >= weekAgo).length;
    const interviewsThisMonth = sessions.filter(s => new Date(s.createdAt) >= monthAgo).length;

    // Type breakdown
    const typeMap = {};
    for (const s of sessions) {
      typeMap[s.interviewType] = (typeMap[s.interviewType] || 0) + 1;
    }
    const typeBreakdown = Object.entries(typeMap).map(([type, count]) => ({ type, count }));

    return {
      totalInterviews, averageScore, scoreTrend, dimensionAverages,
      weakestDimension, interviewsThisWeek, interviewsThisMonth, typeBreakdown,
    };
  }
}

module.exports = new InterviewAnalyticsService();
