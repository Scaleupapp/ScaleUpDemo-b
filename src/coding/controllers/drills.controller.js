'use strict';

const { ArtifactBundle, MetaSkillMastery, DifficultyState } = require('../models');
const { mapObjectiveToRoleTrack, pickWeakestAxis, axisToSubtype } = require('../services/roleTrackMapper');

/**
 * GET /api/coding/drills/today
 *
 * Returns the recommended drill for the authenticated user, selected based on:
 *   - Their primary active UserObjective's canonicalTopic → role_track
 *   - Their DifficultyState for that role_track (created as 'easy' if absent)
 *   - Their MetaSkillMastery weakest axis → drill_subtype
 *   - The most recent active ArtifactBundle matching (type=drill, role_track, difficulty, drill_subtype)
 */
async function getToday(req, res) {
  try {
    const userId = req.user && (req.user.userId || req.user._id || req.user.id);
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    // Fetch the user's primary active objective to derive role_track
    const UserObjective = require('../../models/UserObjective');
    const objective = await UserObjective.findOne({ userId, status: 'active', isPrimary: true }).lean();

    const canonicalTopic = objective && objective.canonicalTopic;
    const role_track = mapObjectiveToRoleTrack(canonicalTopic);
    if (!role_track) {
      return res.status(404).json({ error: 'no_coding_track_for_objective' });
    }

    // Difficulty state — create with 'easy' if missing
    let diffState = await DifficultyState.findOne({ user_id: userId, role_track });
    if (!diffState) {
      diffState = await DifficultyState.create({
        user_id: userId,
        role_track,
        current_difficulty: 'easy',
        recommendation_history: [],
      });
    }

    // Mastery — null is fine; the picker handles the default
    const mastery = await MetaSkillMastery.findOne({ user_id: userId, role_track }).lean();
    const weakestAxis = pickWeakestAxis(mastery);
    const drill_subtype = axisToSubtype(weakestAxis);

    // Find the most recent active bundle matching the criteria
    const bundle = await ArtifactBundle.findOne({
      type: 'drill',
      role_track,
      difficulty: diffState.current_difficulty,
      drill_subtype,
      status: 'active',
    }).sort({ createdAt: -1 }).lean();

    if (!bundle) {
      return res.status(404).json({
        error: 'no_drill_available',
        role_track,
        difficulty: diffState.current_difficulty,
        drill_subtype,
      });
    }

    return res.json({
      bundle_id: bundle._id,
      brief: bundle.brief,
      time_budget_minutes: bundle.time_budget_minutes,
      drill_subtype,
      difficulty: bundle.difficulty,
      role_track,
      language: bundle.language,
      acceptance_criteria: bundle.acceptance_criteria,
      starter_repo: bundle.starter_repo || null,
    });
  } catch (err) {
    console.error('[coding/drills/today]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}

module.exports = { getToday };
