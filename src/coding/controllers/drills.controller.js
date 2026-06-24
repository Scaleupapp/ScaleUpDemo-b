'use strict';

const { ArtifactBundle, MetaSkillMastery, DifficultyState } = require('../models');
const { mapObjectiveToRoleTrack, pickWeakestAxis, axisToSubtype, subtypeToAxis, PHASE_A_DRILL_SUBTYPES, PHASE_A_AXES } = require('../services/roleTrackMapper');
const { evaluateCodingEligibility } = require('../services/codingEligibility');
const { validateDrillSubmission } = require('../validators/drill.validator');
const { randomUUID } = require('crypto');

// Free-tier daily drill quota (non-calibration graded drills per day)
const DAILY_DRILL_QUOTA = 1;

// How many days back to look when excluding recently-attempted bundles for on-demand drills
const RECENT_BUNDLE_EXCLUSION_DAYS = 7;

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

    const eligibility = evaluateCodingEligibility(objective);
    if (!eligibility.eligible) {
      return res.status(404).json({ error: 'no_coding_track_for_objective' });
    }
    const role_track = eligibility.role_track;

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

    // Mastery — if absent, user needs to take calibration first.
    // The mobile Home card uses calibration_required to show the calibration prompt.
    const mastery = await MetaSkillMastery.findOne({ user_id: userId, role_track }).lean();

    // If user has a coding mapping but no MetaSkillMastery doc yet, they need to
    // take calibration first. The mobile Home card uses this signal to show the
    // calibration prompt instead of "no drill available".
    if (!mastery) {
      return res.status(404).json({ error: 'calibration_required', role_track });
    }

    // Daily quota: have we already graded a non-calibration drill today?
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const { DrillAttempt: DrillAttemptModel } = require('../models');
    const drillsToday = await DrillAttemptModel.countDocuments({
      user_id: userId,
      is_calibration: { $ne: true },
      status: 'graded',
      submitted_at: { $gte: startOfDay },
    });
    if (drillsToday >= DAILY_DRILL_QUOTA) {
      return res.status(404).json({
        error: 'daily_quota_used',
        next_drill_at: new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      });
    }

    const weakestAxis = pickWeakestAxis(mastery);
    const drill_subtype = axisToSubtype(weakestAxis);

    // Find the most recent active bundle matching the preferred subtype and difficulty.
    const bundle = await ArtifactBundle.findOne({
      type: 'drill',
      role_track,
      difficulty: diffState.current_difficulty,
      drill_subtype,
      status: 'active',
    }).sort({ createdAt: -1 }).lean();

    // Fallback: if no exact-subtype bundle, try any Phase A subtype at this difficulty.
    let actualBundle = bundle;
    if (!actualBundle) {
      actualBundle = await ArtifactBundle.findOne({
        type: 'drill',
        role_track,
        difficulty: diffState.current_difficulty,
        drill_subtype: { $in: PHASE_A_DRILL_SUBTYPES },
        status: 'active',
      }).sort({ createdAt: -1 }).lean();
    }

    if (!actualBundle) {
      return res.status(404).json({
        error: 'no_drill_available',
        role_track,
        difficulty: diffState.current_difficulty,
        drill_subtype,
      });
    }

    return res.json({
      bundle_id: actualBundle._id,
      brief: actualBundle.brief,
      time_budget_minutes: actualBundle.time_budget_minutes,
      drill_subtype,
      difficulty: actualBundle.difficulty,
      role_track,
      language: actualBundle.language,
      acceptance_criteria: actualBundle.acceptance_criteria,
      starter_repo: actualBundle.starter_repo || null,
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
      drill_subtype: bundle.drill_subtype,  // denormalized for query matching
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
      what_you_missed: attempt.grade.what_you_missed || [],
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

// ---------------------------------------------------------------------------
// baselineFromDrills(drillAttempts) → { axes, recommended_difficulty, average }
// drillAttempts must be graded and have drill_subtype set directly on them.
// ---------------------------------------------------------------------------

function baselineFromDrills(drillAttempts) {
  const axes = { prompting: 0, verification: 0, decomposition: 0, refactoring: 0 };
  for (const a of drillAttempts) {
    const axis = subtypeToAxis(a.drill_subtype);
    axes[axis] = a.grade.overall_score;
  }
  // refactoring intentionally stays at 0 — unmeasured in Phase A
  const measuredScores = PHASE_A_AXES.map(k => axes[k]);
  const avg = measuredScores.reduce((s, v) => s + v, 0) / measuredScores.length;
  let recommended_difficulty = 'easy';
  if (avg > 90) recommended_difficulty = 'hard';
  else if (avg > 80) recommended_difficulty = 'medium';
  return { axes, recommended_difficulty, average: avg };
}

// ---------------------------------------------------------------------------
// POST /api/coding/drills/calibration/start
// ---------------------------------------------------------------------------

async function startCalibration(req, res) {
  try {
    const userId = req.user && (req.user.userId || req.user._id || req.user.id);
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    // Get user's role_track
    const UserObjective = require('../../models/UserObjective');
    const objective = await UserObjective.findOne({ userId, status: 'active', isPrimary: true }).lean();
    const eligibility = evaluateCodingEligibility(objective);
    if (!eligibility.eligible) {
      return res.status(404).json({ error: 'no_coding_track_for_objective' });
    }
    const role_track = eligibility.role_track;

    const models = require('../models');

    // Fetch one easy active bundle per Phase A subtype (prompt, verify, decompose)
    const bundleResults = await Promise.all(
      PHASE_A_DRILL_SUBTYPES.map(subtype =>
        models.ArtifactBundle.findOne({
          type: 'drill',
          role_track,
          difficulty: 'easy',
          drill_subtype: subtype,
          status: 'active',
        }).sort({ createdAt: -1 }).lean()
      )
    );

    // Check all 3 Phase A bundles are available
    const missing = PHASE_A_DRILL_SUBTYPES.filter((_, i) => !bundleResults[i]);
    if (missing.length > 0) {
      return res.status(503).json({
        error: 'calibration_unavailable',
        missing_subtypes: missing,
      });
    }

    // Generate a calibration_id
    const calibration_id = randomUUID();
    const now = new Date();

    // Create 3 DrillAttempts atomically
    const attempts = await Promise.all(
      bundleResults.map((bundle, i) =>
        models.DrillAttempt.create({
          user_id: userId,
          bundle_id: bundle._id,
          drill_subtype: PHASE_A_DRILL_SUBTYPES[i],
          status: 'in_progress',
          started_at: now,
          is_calibration: true,
          calibration_id,
        })
      )
    );

    // Build safe views with time_budget_minutes overridden to 2 (3 drills × 2 min = 6 min total)
    const drills = bundleResults.map((bundle, i) => {
      const view = safeBundleView(bundle, attempts[i]._id);
      view.time_budget_minutes = 2;
      return view;
    });

    return res.json({
      calibration_id,
      role_track,
      estimated_minutes: 6,
      drills,
    });
  } catch (err) {
    console.error('[coding/drills/calibration/start]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}

// ---------------------------------------------------------------------------
// POST /api/coding/drills/calibration/:calibration_id/submit
// ---------------------------------------------------------------------------

async function submitCalibration(req, res) {
  try {
    const userId = req.user && (req.user.userId || req.user._id || req.user.id);
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    const { calibration_id } = req.params;

    const { submissions } = req.body;

    // Must have exactly 3 submissions (one per Phase A subtype)
    if (!Array.isArray(submissions) || submissions.length !== PHASE_A_DRILL_SUBTYPES.length) {
      return res.status(400).json({ error: 'invalid_submission_count', expected: PHASE_A_DRILL_SUBTYPES.length, received: submissions ? submissions.length : 0 });
    }

    // Validate each submission shape
    for (const sub of submissions) {
      const { error: validationError } = validateDrillSubmission({
        drill_subtype: sub.drill_subtype,
        submission: sub.submission,
      });
      if (validationError) {
        return res.status(400).json({ error: 'invalid_submission', drill_subtype: sub.drill_subtype, detail: validationError.message });
      }
    }

    const models = require('../models');

    // Find all in_progress attempts for this calibration
    const attempts = await models.DrillAttempt.find({
      user_id: userId,
      calibration_id,
    });

    if (!attempts || attempts.length !== PHASE_A_DRILL_SUBTYPES.length) {
      return res.status(404).json({ error: 'calibration_not_found' });
    }

    // Match each submission to an attempt by drill_subtype and update
    const now = new Date();
    await Promise.all(
      submissions.map(sub => {
        const attempt = attempts.find(a => a.drill_subtype === sub.drill_subtype);
        if (!attempt) {
          console.error('[coding/drills/calibration/submit] save: no attempt for', sub.drill_subtype);
          return Promise.resolve();
        }
        const time_taken_seconds = Math.floor(
          (Date.now() - new Date(attempt.started_at).getTime()) / 1000
        );
        attempt.status = 'submitted';
        attempt.submitted_at = now;
        attempt.time_taken_seconds = time_taken_seconds;
        attempt.submission = sub.submission;
        return attempt.save();
      })
    );

    // Enqueue 3 grader jobs
    const workers = getWorkers();
    await Promise.all(
      submissions.map(sub => {
        const attempt = attempts.find(a => a.drill_subtype === sub.drill_subtype);
        if (!attempt) {
          console.error('[coding/drills/calibration/submit] enqueue: no attempt for', sub.drill_subtype);
          return Promise.resolve();
        }
        return workers.drillGraderQueue.add('grade', {
          drillAttemptId: attempt._id.toString(),
          drill_subtype: sub.drill_subtype,
        });
      })
    );

    return res.status(202).json({
      calibration_id,
      status: 'submitted',
      poll_url: `/api/coding/drills/calibration/${calibration_id}/result`,
    });
  } catch (err) {
    console.error('[coding/drills/calibration/submit]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}

// ---------------------------------------------------------------------------
// GET /api/coding/drills/calibration/:calibration_id/result
// ---------------------------------------------------------------------------

async function getCalibrationResult(req, res) {
  try {
    const userId = req.user && (req.user.userId || req.user._id || req.user.id);
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    const { calibration_id } = req.params;

    const models = require('../models');

    const attempts = await models.DrillAttempt.find({
      user_id: userId,
      calibration_id,
    });

    if (!attempts || attempts.length === 0) {
      return res.status(404).json({ error: 'calibration_not_found' });
    }

    const gradedCount = attempts.filter(a => a.status === 'graded').length;
    let status;
    if (gradedCount === attempts.length) {
      status = 'graded';
    } else if (gradedCount > 0) {
      status = 'partial';
    } else {
      status = 'pending';
    }

    const drillsView = attempts.map(a => ({
      drill_subtype: a.drill_subtype,
      status: a.status,
      overall_score: a.grade ? a.grade.overall_score : null,
      rubric_breakdown: a.grade ? a.grade.rubric_breakdown : null,
      what_you_missed: a.grade ? (a.grade.what_you_missed || []) : [],
    }));

    if (status !== 'graded') {
      return res.status(202).json({
        calibration_id,
        status,
        drills: drillsView,
      });
    }

    // All 3 Phase A drills graded — compute baseline (refactoring axis stays at 0, unmeasured)
    const { axes, recommended_difficulty } = baselineFromDrills(attempts);

    // Write Mastery + DifficultyState if not already committed
    const alreadyCommitted = attempts.some(a => a.calibration_committed);
    if (!alreadyCommitted) {
      // Determine role_track from the first attempt's bundle_id lookup (use stored info)
      // We need role_track — look it up from the user's objective
      const UserObjective = require('../../models/UserObjective');
      const objective = await UserObjective.findOne({ userId, status: 'active', isPrimary: true }).lean();
      const role_track = mapObjectiveToRoleTrack(objective && objective.canonicalTopic) || 'swe';

      await models.MetaSkillMastery.findOneAndUpdate(
        { user_id: userId, role_track },
        {
          $set: {
            axes,
            last_updated: new Date(),
          },
          $setOnInsert: {
            confidence: 0.5,
            attempt_count: 0,
          },
        },
        { upsert: true, new: true }
      );

      await models.DifficultyState.findOneAndUpdate(
        { user_id: userId, role_track },
        {
          $set: { current_difficulty: recommended_difficulty },
          $push: {
            recommendation_history: {
              recommended: recommended_difficulty,
              reason: 'calibration_baseline',
              accepted: true,
              timestamp: new Date(),
            },
          },
        },
        { upsert: true, new: true }
      );

      // Mark all attempts as committed
      await Promise.all(attempts.map(a => {
        a.calibration_committed = true;
        return a.save();
      }));
    }

    return res.json({
      calibration_id,
      status: 'graded',
      drills: drillsView,
      baseline_axes: axes,
      recommended_difficulty,
    });
  } catch (err) {
    console.error('[coding/drills/calibration/result]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}

// ---------------------------------------------------------------------------
// POST /api/coding/drills/request
//
// On-demand drill request — bypasses the daily quota. Picks weakest-axis
// subtype + current difficulty when not specified. Excludes bundles the user
// attempted in the last RECENT_BUNDLE_EXCLUSION_DAYS days.
// ---------------------------------------------------------------------------

async function requestDrill(req, res) {
  try {
    const userId = req.user && (req.user.userId || req.user._id || req.user.id);
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    // Validate body — all fields optional
    const { drill_subtype, difficulty, topic_hint } = req.body || {};
    if (drill_subtype && !PHASE_A_DRILL_SUBTYPES.includes(drill_subtype)) {
      return res.status(400).json({ error: 'invalid_drill_subtype', allowed: PHASE_A_DRILL_SUBTYPES });
    }
    if (difficulty && !['easy', 'medium', 'hard'].includes(difficulty)) {
      return res.status(400).json({ error: 'invalid_difficulty' });
    }

    // Eligibility — must have a coding objective
    let UserObjective;
    try { UserObjective = require('../../models/UserObjective'); } catch (e) { UserObjective = require('../../models/userObjective'); }
    const obj = await UserObjective.findOne({ userId, status: 'active', isPrimary: true }).lean();
    const eligibility = evaluateCodingEligibility(obj);
    if (!eligibility.eligible) return res.status(404).json({ error: 'no_coding_track_for_objective' });
    const role_track = eligibility.role_track;

    const models = require('../models');

    // If subtype not specified, pick weakest axis
    let finalSubtype = drill_subtype;
    if (!finalSubtype) {
      const mastery = await models.MetaSkillMastery.findOne({ user_id: userId, role_track }).lean();
      const weakestAxis = pickWeakestAxis(mastery);
      finalSubtype = axisToSubtype(weakestAxis);
    }

    // If difficulty not specified, use current DifficultyState
    let finalDifficulty = difficulty;
    if (!finalDifficulty) {
      const diffState = await models.DifficultyState.findOne({ user_id: userId, role_track }).lean();
      finalDifficulty = diffState?.current_difficulty || 'easy';
    }

    // Find bundles NOT consumed by the user in the last RECENT_BUNDLE_EXCLUSION_DAYS days
    const exclusionDate = new Date(Date.now() - RECENT_BUNDLE_EXCLUSION_DAYS * 24 * 60 * 60 * 1000);
    const recentAttempts = await models.DrillAttempt.find({
      user_id: userId,
      started_at: { $gte: exclusionDate },
    }).select('bundle_id').lean();
    const excludeBundleIds = recentAttempts.map(a => a.bundle_id);

    // Build the bundle query
    const bundleQuery = {
      type: 'drill',
      role_track,
      drill_subtype: finalSubtype,
      difficulty: finalDifficulty,
      status: 'active',
      _id: { $nin: excludeBundleIds },
    };

    let bundle = null;

    // If topic_hint provided, attempt case-insensitive substring match against brief
    if (topic_hint && typeof topic_hint === 'string' && topic_hint.trim().length > 0) {
      bundle = await models.ArtifactBundle.findOne({
        ...bundleQuery,
        brief: { $regex: topic_hint.trim(), $options: 'i' },
      }).lean();
    }

    // Fallback: any matching bundle (most recent first)
    if (!bundle) {
      bundle = await models.ArtifactBundle.findOne(bundleQuery).sort({ createdAt: -1 }).lean();
    }

    // Last-resort fallback: drop the exclusion list (user has done all bundles in their bucket)
    if (!bundle) {
      bundle = await models.ArtifactBundle.findOne({
        type: 'drill',
        role_track,
        drill_subtype: finalSubtype,
        difficulty: finalDifficulty,
        status: 'active',
      }).sort({ createdAt: -1 }).lean();
    }

    if (!bundle) {
      return res.status(404).json({
        error: 'no_drill_available',
        role_track,
        difficulty: finalDifficulty,
        drill_subtype: finalSubtype,
      });
    }

    // Create the DrillAttempt — is_user_requested: true flags this as an on-demand extra
    const attempt = await models.DrillAttempt.create({
      user_id: userId,
      bundle_id: bundle._id,
      drill_subtype: bundle.drill_subtype,
      status: 'in_progress',
      started_at: new Date(),
      is_calibration: false,
      is_user_requested: true,
    });

    // Return the same safe bundle view as startDrill — iOS can reuse rendering
    return res.json(safeBundleView(bundle, attempt._id));
  } catch (err) {
    console.error('[coding/drills/request]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}

module.exports = {
  getToday,
  startDrill,
  submitDrill,
  getResult,
  startCalibration,
  submitCalibration,
  getCalibrationResult,
  baselineFromDrills,
  requestDrill,
  _setWorkersModule,
  safeBundleView,
};
