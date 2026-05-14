/**
 * v2 Insights routes.
 *
 *   GET /api/v2/insights/top-actions — top 3 leverage actions for the user right now
 *   GET /api/v2/insights/trajectory  — readiness forecast for current primary objective
 *
 * These power the v2 Calibration screen, Home trajectory bar, and Compass insight mode.
 */
const express = require('express');
const auth = require('../../middleware/auth');
const UserObjective = require('../../models/UserObjective');
const KnowledgeProfile = require('../../models/KnowledgeProfile');
const { forecastTrajectory } = require('../../services/v2/trajectoryService');

const router = express.Router();

router.get('/top-actions', auth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const knowledge = await KnowledgeProfile.findOne({ userId }).lean();

    const topicEntries = knowledge?.topicProfiles
      ? Object.entries(knowledge.topicProfiles).map(([topic, t]) => ({
          topic,
          mastery: t.masteryLevel || 0,
          trend: t.trend || 'flat',
          quizzesTaken: t.quizzesTaken || 0,
        }))
      : [];

    // Rank by lowest mastery × weight (would weight by objective importance — v1 ranking)
    const ranked = topicEntries
      .filter(t => t.mastery < 70)
      .sort((a, b) => a.mastery - b.mastery)
      .slice(0, 3);

    const actions = ranked.map((t, i) => ({
      rank: i + 1,
      title: `Focus ${t.topic}`,
      detail: `Currently at ${t.mastery}%. ${t.quizzesTaken === 0 ? 'No quiz attempts yet.' : `Recent trend: ${t.trend}.`}`,
      action: { type: 'topic_deep_dive', topic: t.topic },
    }));

    // Fillers if we don't have 3
    const fillers = [
      { title: 'Take a quiz on your strongest topic', detail: 'Confirm retention before moving on.', action: { type: 'quiz_strong' } },
      { title: 'Do a mock interview', detail: 'You haven’t practiced under pressure in a while.', action: { type: 'interview' } },
      { title: 'Recap last week\'s content', detail: 'Spaced repetition window is open.', action: { type: 'reflection' } },
    ];
    while (actions.length < 3 && fillers.length) {
      const f = fillers.shift();
      actions.push({ rank: actions.length + 1, ...f });
    }

    return res.json({ success: true, data: { actions } });
  } catch (err) {
    console.error('[v2/insights/top-actions] error', err);
    return res.status(500).json({ success: false, message: 'Failed to load top actions' });
  }
});

router.get('/trajectory', auth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const objective = await UserObjective.findOne({ userId, status: 'active', isPrimary: true });
    if (!objective) return res.status(404).json({ success: false, message: 'No active objective' });

    const knowledge = await KnowledgeProfile.findOne({ userId }).lean();
    const profiles = knowledge?.topicProfiles
      ? Object.values(knowledge.topicProfiles)
      : [];
    const current = profiles.length
      ? Math.round(profiles.reduce((s, t) => s + (t.masteryLevel || 0), 0) / profiles.length)
      : 30;

    const trajectory = forecastTrajectory({
      currentReadiness: current,
      objectiveType: objective.objectiveType,
      specifics: objective.specifics || {},
      timeline: objective.timeline,
      currentLevel: objective.currentLevel,
    });

    return res.json({ success: true, data: trajectory });
  } catch (err) {
    console.error('[v2/insights/trajectory] error', err);
    return res.status(500).json({ success: false, message: 'Failed to compute trajectory' });
  }
});

module.exports = router;
