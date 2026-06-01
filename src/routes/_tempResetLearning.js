'use strict';

/**
 * TEMPORARY — admin-only "reset my learning data" endpoint.
 *
 * ⚠️  REMOVE THIS FILE + its mount in app.js once the one-time reset is done.
 *
 * Safety rails:
 *   - adminAuth (auth + rbac('admin'))
 *   - Only ever touches the CALLER'S OWN account (userId = req.user.userId).
 *   - dry-run is the default; execute requires { mode:'execute', confirmEmail }
 *     where confirmEmail must equal the caller's own email.
 *   - PRESERVES: the User account (flags reset), Content the user authored,
 *     CreatorProfile/Application, AuditLog, llmSpend.
 *   - On execute it returns the deleted documents as a backup payload.
 */

const express = require('express');
const mongoose = require('mongoose');
const adminAuth = require('../middleware/adminAuth');
const User = require('../models/User');

const router = express.Router();

// [requirePath, userField] — defensively required; field existence is verified
// against the schema so a wrong field surfaces as `field_not_found` (count 0)
// instead of erroring or deleting the wrong thing.
const DELETE_TARGETS = [
  // v1/v2 (userId)
  ['../models/UserObjective', 'userId'],
  ['../models/Plan', 'userId'],
  ['../models/Journey', 'userId'],
  ['../models/KnowledgeProfile', 'userId'],
  ['../models/CognitiveProfile', 'userId'],
  ['../models/ConceptMastery', 'userId'],
  ['../models/MisconceptionLedger', 'userId'],
  ['../models/UserInference', 'userId'],
  ['../models/ProgressInsightSnapshot', 'userId'],
  ['../models/ReadinessSnapshot', 'userId'],
  ['../models/DiagnosticAttempt', 'userId'],
  ['../models/DiagnosticSyllabus', 'userId'],
  ['../models/Quiz', 'userId'],
  ['../models/QuizAttempt', 'userId'],
  ['../models/QuizTrigger', 'userId'],
  ['../models/InterviewSession', 'userId'],
  ['../models/ContentProgress', 'userId'],
  ['../models/ContentInteraction', 'userId'],
  ['../models/ConsumptionGraph', 'userId'],
  ['../models/ExternalContentTouch', 'userId'],
  ['../models/CompetitionProfile', 'userId'],
  ['../models/ChallengeAttempt', 'userId'],
  ['../models/WeeklyLeaderboard', 'userId'],
  ['../models/LiveEventAttempt', 'userId'],
  ['../models/FlashcardSet', 'userId'],
  ['../models/MindMap', 'userId'],
  ['../models/Playlist', 'userId'],
  ['../models/Notification', 'userId'],
  ['../models/CompassConversation', 'userId'],
  ['../models/Conversation', 'userId'],
  ['../models/Comment', 'userId'],
  ['../models/NoteRequestUpvote', 'userId'],
  // coding (user_id)
  ['../coding/models/capstoneSession.model', 'user_id'],
  ['../coding/models/drillAttempt.model', 'user_id'],
  ['../coding/models/metaSkillMastery.model', 'user_id'],
  ['../coding/models/difficultyState.model', 'user_id'],
  ['../coding/models/trackEnrollment.model', 'user_id'],
  ['../coding/models/capstoneGenerationRequest.model', 'user_id'],
  ['../coding/models/pairingCode.model', 'user_id'],
  ['../coding/models/shareToken.model', 'user_id'],
];

function loadModel(p) {
  try {
    const m = require(p);
    // some modules export the model directly
    return (m && m.modelName) ? m : (m && m.default && m.default.modelName ? m.default : null);
  } catch (e) {
    return null;
  }
}

async function handleReset(req, res) {
  try {
    const userId = req.user.userId || req.user._id || req.user.id;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'user not found' });

    const mode = (req.body && req.body.mode) === 'execute' ? 'execute' : 'dry-run';
    if (mode === 'execute') {
      const confirm = String((req.body && req.body.confirmEmail) || '').toLowerCase().trim();
      if (!confirm || confirm !== String(user.email).toLowerCase().trim()) {
        return res.status(400).json({ success: false, message: 'execute requires confirmEmail === your own email' });
      }
    }

    const perCollection = {};
    const skipped = {};
    const backup = {};
    let totalToDelete = 0;

    // Special-case: capstone recordings are keyed by session_id, not user. Find
    // the user's session ids first so we can clean them up too.
    let capstoneSessionIds = [];
    const CapstoneSession = loadModel('../coding/models/capstoneSession.model');
    if (CapstoneSession) {
      capstoneSessionIds = (await CapstoneSession.find({ user_id: userId }).select('_id').lean()).map((s) => s._id);
    }

    for (const [p, field] of DELETE_TARGETS) {
      const Model = loadModel(p);
      const key = p.split('/').pop();
      if (!Model) { skipped[key] = 'model_not_loaded'; continue; }
      if (!Model.schema.path(field)) { skipped[key] = `field_not_found:${field}`; continue; }

      const filter = { [field]: userId };
      const count = await Model.countDocuments(filter);
      perCollection[key] = count;
      totalToDelete += count;

      if (mode === 'execute' && count > 0) {
        backup[key] = await Model.find(filter).lean();
        await Model.deleteMany(filter);
      }
    }

    // Capstone recordings (by session id)
    const CapstoneRecording = loadModel('../coding/models/capstoneRecording.model');
    if (CapstoneRecording && capstoneSessionIds.length) {
      const recFilter = { session_id: { $in: capstoneSessionIds } };
      const recCount = await CapstoneRecording.countDocuments(recFilter);
      perCollection['capstoneRecording.model'] = recCount;
      totalToDelete += recCount;
      if (mode === 'execute' && recCount > 0) {
        backup['capstoneRecording.model'] = await CapstoneRecording.find(recFilter).lean();
        await CapstoneRecording.deleteMany(recFilter);
      }
    }

    // Reset the User to a fresh, pre-onboarding state (execute only).
    let userReset = null;
    if (mode === 'execute') {
      const before = {
        onboardingComplete: user.onboardingComplete,
        onboardingStep: user.onboardingStep,
        diagnosticComplete: user.diagnosticComplete,
        v2NeedsOnboarding: user.v2NeedsOnboarding,
      };
      user.onboardingComplete = false;
      user.onboardingStep = 0;
      user.diagnosticComplete = false;
      user.v2OptedIn = true;          // keep them on v2
      user.v2NeedsOnboarding = true;  // route into v2 onboarding
      await user.save();
      userReset = { before, after: { onboardingComplete: false, onboardingStep: 0, diagnosticComplete: false, v2OptedIn: true, v2NeedsOnboarding: true } };
    }

    return res.json({
      success: true,
      mode,
      user: { id: String(userId), email: user.email, role: user.role },
      preserved: ['User (account, flags reset)', 'Content (authored)', 'CreatorProfile', 'CreatorApplication', 'AuditLog', 'llmSpend'],
      totalToDelete,
      perCollection,
      skipped,
      userReset,
      // backup only present on execute — save this response to a local file.
      backup: mode === 'execute' ? backup : undefined,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message, stack: err.stack });
  }
}

router.post('/reset-learning', adminAuth, handleReset);

module.exports = router;
