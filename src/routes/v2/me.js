/**
 * v2 per-user status — drives the client's v2-vs-v1 routing.
 *
 *   GET  /api/v2/me/status        — am I on v2? do I need onboarding? show the prompt?
 *   POST /api/v2/me/prompt-dismissed — record that the "try v2" prompt was shown/dismissed
 *
 * Routing model (matches the product decision):
 *   - New users (no prior data) are forced onto v2 — opted in here, on first
 *     status fetch, with v2NeedsOnboarding set. There is no path back to v1.
 *   - Existing users (have data) stay on v1 and see a "try v2" prompt. They
 *     can accept (POST /api/v2/opt-in/v2) which sets v2NeedsOnboarding so they
 *     re-onboard, keeping their history. Declining re-shows after a cooldown.
 *
 * The whole /api/v2 router is gated by the V2_API_ENABLED kill switch — when
 * it's off this route doesn't mount, the client's fetch fails, and it falls
 * back to v1. So rollback stays a single env var.
 */
const express = require('express');
const auth = require('../../middleware/auth');
const User = require('../../models/User');
const UserObjective = require('../../models/UserObjective');

const router = express.Router();

// How long to wait before re-showing the "try v2" prompt to an existing user
// who dismissed it. "Ask again later", not "nag every launch".
const PROMPT_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

router.get('/status', auth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const user = await User.findById(userId)
      .select('v2OptedIn v2NeedsOnboarding v2PromptLastShownAt onboardingComplete')
      .lean();

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Already on v2 — stays on v2 (no path back to v1).
    if (user.v2OptedIn) {
      return res.json({
        success: true,
        data: {
          v2Enabled: true,
          needsOnboarding: !!user.v2NeedsOnboarding,
          shouldShowPrompt: false,
        },
      });
    }

    // Not opted in — is this a brand-new account or an existing user with data?
    const hasObjective = await UserObjective.exists({ userId });
    const hasData = !!hasObjective || !!user.onboardingComplete;

    if (!hasData) {
      // New user — force v2. Opt them in now and mark them for onboarding.
      await User.updateOne(
        { _id: userId },
        { $set: { v2OptedIn: true, v2OptedInAt: new Date(), v2NeedsOnboarding: true } }
      );
      return res.json({
        success: true,
        data: { v2Enabled: true, needsOnboarding: true, shouldShowPrompt: false },
      });
    }

    // Existing user with data — stay on v1, maybe show the "try v2" prompt.
    const last = user.v2PromptLastShownAt
      ? new Date(user.v2PromptLastShownAt).getTime()
      : 0;
    const shouldShowPrompt = Date.now() - last > PROMPT_COOLDOWN_MS;

    return res.json({
      success: true,
      data: { v2Enabled: false, needsOnboarding: false, shouldShowPrompt },
    });
  } catch (err) {
    console.error('[v2/me/status] error', err);
    return res.status(500).json({ success: false, message: 'Failed to load v2 status' });
  }
});

// Existing user saw (and dismissed) the "try v2" prompt — start the cooldown.
router.post('/prompt-dismissed', auth, async (req, res) => {
  try {
    await User.updateOne(
      { _id: req.user.userId },
      { $set: { v2PromptLastShownAt: new Date() } }
    );
    return res.json({ success: true, data: { recorded: true } });
  } catch (err) {
    console.error('[v2/me/prompt-dismissed] error', err);
    return res.status(500).json({ success: false, message: 'Failed to record dismissal' });
  }
});

const { resolvePersona } = require('../../services/institution/personaResolver');

// Persona resolver — placement vs general. Additive; /status is unchanged.
router.get('/context', auth, async (req, res) => {
  try {
    const data = await resolvePersona(req.user.userId);
    return res.json({ success: true, data });
  } catch (err) {
    console.error('[v2/me/context] error', err);
    return res.status(500).json({ success: false, message: 'Failed to resolve context' });
  }
});

// Switch a DUAL-context user's active experience (placement <-> personal).
// Persists User.preferredContext and makes the chosen track's objective primary
// so the v2 home/plan/diagnostic scope to it. Returns the freshly resolved context.
// No-op-safe for non-dual users (they simply won't have the other objective).
router.post('/context/switch', auth, async (req, res) => {
  try {
    const objectiveService = require('../../services/objectiveService');
    const { context } = req.body || {};
    if (!['placement', 'personal'].includes(context)) {
      return res.status(400).json({ success: false, message: "context must be 'placement' or 'personal'" });
    }
    await User.findByIdAndUpdate(req.user.userId, { preferredContext: context });

    // Make the chosen track's objective primary so home/plan scope to it.
    const filter = context === 'placement'
      ? { userId: req.user.userId, status: 'active', 'institutionContext.locked': true }
      : { userId: req.user.userId, status: 'active', 'institutionContext.locked': { $ne: true } };
    const target = await UserObjective.findOne(filter).sort({ isPrimary: -1, createdAt: -1 });
    if (target && !target.isPrimary) {
      await objectiveService.setPrimary(req.user.userId, target._id);
    }

    const data = await resolvePersona(req.user.userId);
    return res.json({ success: true, data });
  } catch (err) {
    console.error('[v2/me/context/switch] error', err);
    return res.status(500).json({ success: false, message: 'Failed to switch context' });
  }
});

// Redeem a 6-digit invite code → enrol the signed-in student into their cohort.
// Works even if their app email differs from the roster email. Returns the freshly
// resolved context so the app can route into the placement shell.
router.post('/claim-code', auth, async (req, res) => {
  try {
    const { code } = req.body || {};
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const enrollment = await require('../../services/institution/rosterClaimService').claimByCode(user, code);
    if (!enrollment) {
      return res.status(404).json({ success: false, code: 'INVALID_CODE', message: 'That code is invalid or has already been used.' });
    }
    const data = await resolvePersona(req.user.userId);
    return res.json({ success: true, data });
  } catch (err) {
    console.error('[v2/me/claim-code] error', err);
    return res.status(500).json({ success: false, message: 'Could not redeem the code.' });
  }
});

// Student assessment routes — list scheduled assessments, start, sync.
// The studentAssessments router manages its own auth per-handler (same D2C `auth`).
// Mounted here so final paths are /api/v2/me/assessments/*.
router.use('/', require('../institution/studentAssessments'));

module.exports = router;
