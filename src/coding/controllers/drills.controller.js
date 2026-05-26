'use strict';

const { ArtifactBundle, MetaSkillMastery, DifficultyState } = require('../models');
const { mapObjectiveToRoleTrack, pickWeakestAxis, axisToSubtype } = require('../services/roleTrackMapper');
const { validateDrillSubmission } = require('../validators/drill.validator');

// ---------------------------------------------------------------------------
// Test seam: allows tests to inject a fake workers module
// ---------------------------------------------------------------------------
let _workersModule = null;

function _setWorkersModule(mod) {
  _workersModule = mod;
}

function getWorkers() {
  if (_workersModule) return _workersModule;
  return require('../workers');
}

// ---------------------------------------------------------------------------
// Safe bundle view — strips all secret / grader-only fields
// ---------------------------------------------------------------------------

function safeBundleView(bundle, attemptId) {
  const view = {
    attempt_id: attemptId,
    bundle_id: bundle._id,
    brief: bundle.brief,
    time_budget_minutes: bundle.time_budget_minutes,
    drill_subtype: bundle.drill_subtype,
    difficulty: bundle.difficulty,
    role_track: bundle.role_track,
    language: bundle.language,
    acceptance_criteria: bundle.acceptance_criteria,
  };
  if (bundle.drill_subtype === 'refactor') {
    view.starter_repo = bundle.starter_repo;
    view.visible_tests = (bundle.visible_tests || []).map(t => ({
      name: t.name,
      command: t.command,
    }));
  }
  return view;
}

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

// ---------------------------------------------------------------------------
// POST /api/coding/drills/:id/start
// ---------------------------------------------------------------------------

async function startDrill(req, res) {
  try {
    const userId = req.user && (req.user.userId || req.user._id || req.user.id);
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    const bundleId = req.params.id;

    const models = require('../models');
    const bundle = await models.ArtifactBundle.findById(bundleId).lean();
    if (!bundle || bundle.status !== 'active') {
      return res.status(404).json({ error: 'bundle_not_found' });
    }

    // Daily quota check: 1 non-calibration drill per day (free-tier limit)
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todayCount = await models.DrillAttempt.countDocuments({
      user_id: userId,
      createdAt: { $gte: startOfDay },
      is_calibration: { $ne: true },
    });
    if (todayCount >= 1) {
      return res.status(429).json({ error: 'daily_quota_exceeded', limit: 1 });
    }

    const attempt = await models.DrillAttempt.create({
      user_id: userId,
      bundle_id: bundleId,
      status: 'in_progress',
      started_at: new Date(),
      is_calibration: false,
    });

    return res.json(safeBundleView(bundle, attempt._id));
  } catch (err) {
    console.error('[coding/drills/start]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}

// ---------------------------------------------------------------------------
// POST /api/coding/drills/:id/submit
// ---------------------------------------------------------------------------

async function submitDrill(req, res) {
  try {
    const userId = req.user && (req.user.userId || req.user._id || req.user.id);
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    const bundleId = req.params.id;

    // Validate submission shape
    const { error: validationError } = validateDrillSubmission(req.body);
    if (validationError) {
      return res.status(400).json({ error: 'invalid_submission', detail: validationError.message });
    }

    const models = require('../models');
    const bundle = await models.ArtifactBundle.findById(bundleId).lean();
    if (!bundle) {
      return res.status(404).json({ error: 'bundle_not_found' });
    }
    if (bundle.drill_subtype !== req.body.drill_subtype) {
      return res.status(400).json({ error: 'subtype_mismatch' });
    }

    // Find most-recent in_progress attempt within last 60 minutes
    const sixtyMinAgo = new Date(Date.now() - 60 * 60 * 1000);
    const attempt = await models.DrillAttempt.findOne({
      user_id: userId,
      bundle_id: bundleId,
      status: 'in_progress',
      started_at: { $gte: sixtyMinAgo },
    }).sort({ createdAt: -1 });

    if (!attempt) {
      return res.status(404).json({ error: 'no_active_attempt' });
    }

    const time_taken_seconds = Math.floor(
      (Date.now() - new Date(attempt.started_at).getTime()) / 1000
    );
    attempt.status = 'submitted';
    attempt.submitted_at = new Date();
    attempt.time_taken_seconds = time_taken_seconds;
    attempt.submission = req.body.submission;
    await attempt.save();

    // Enqueue grading job
    const workers = getWorkers();
    await workers.drillGraderQueue.add('grade', {
      drillAttemptId: attempt._id.toString(),
      drill_subtype: req.body.drill_subtype,
    });

    return res.status(202).json({
      attempt_id: attempt._id,
      status: 'submitted',
      poll_url: `/api/coding/drills/${bundleId}/result`,
    });
  } catch (err) {
    console.error('[coding/drills/submit]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}

// ---------------------------------------------------------------------------
// GET /api/coding/drills/:id/result
// ---------------------------------------------------------------------------

async function getResult(req, res) {
  try {
    const userId = req.user && (req.user.userId || req.user._id || req.user.id);
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    const bundleId = req.params.id;

    const models = require('../models');
    const attempt = await models.DrillAttempt.findOne({
      user_id: userId,
      bundle_id: bundleId,
    }).sort({ createdAt: -1 }).lean();

    if (!attempt) {
      return res.status(404).json({ error: 'no_attempt_found' });
    }

    if (attempt.status !== 'graded') {
      return res.status(202).json({ status: attempt.status, attempt_id: attempt._id });
    }

    const bundle = await models.ArtifactBundle.findById(bundleId).lean();
    return res.json({
      attempt_id: attempt._id,
      status: 'graded',
      overall_score: attempt.grade.overall_score,
      rubric_breakdown: attempt.grade.rubric_breakdown,
      what_to_try_next: attempt.grade.what_to_try_next,
      integrity_confidence: attempt.grade.integrity_confidence,
      graded_at: attempt.grade.graded_at,
      drill_subtype: bundle.drill_subtype,
      difficulty: bundle.difficulty,
      role_track: bundle.role_track,
    });
  } catch (err) {
    console.error('[coding/drills/result]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}

module.exports = { getToday, startDrill, submitDrill, getResult, _setWorkersModule };
