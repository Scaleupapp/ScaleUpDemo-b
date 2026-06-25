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
      .select('v2OptedIn v2NeedsOnboarding onboardingComplete diagnosticComplete')
      .lean();

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // v2 is the DEFAULT experience for EVERYONE now — there is no v1 fallback and no
    // "try v2" prompt. (The old logic kept anyone with a UserObjective on v1, which
    // wrongly dropped placement students — who get a seeded institutional objective —
    // onto the v1 home.) Opt every user in on first sight so the flag is sticky.
    if (!user.v2OptedIn) {
      await User.updateOne(
        { _id: userId },
        { $set: { v2OptedIn: true, v2OptedInAt: new Date() } }
      );
    }

    // A user only still needs onboarding if they have NOT completed the diagnostic.
    // Anyone who finished it (including our placement students) goes straight to Home
    // — never back into the onboarding flow.
    const needsOnboarding = !user.diagnosticComplete;

    return res.json({
      success: true,
      data: { v2Enabled: true, needsOnboarding, shouldShowPrompt: false },
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

// Placement onboarding prefill — everything the short placement signup flow needs
// pre-filled from the roster + cohort, so the student doesn't re-enter it: their
// name, institution, branch (department), year (cohort), roll number, and the
// objective's competency topics to self-rate. 404 if not a placement student.
router.get('/placement-onboarding', auth, async (req, res) => {
  try {
    const InstitutionEnrollment = require('../../models/InstitutionEnrollment');
    const UserObjective = require('../../models/UserObjective');
    const enr = await InstitutionEnrollment
      .findOne({ userId: req.user.userId, status: { $in: ['registered', 'diagnostic_done', 'active'] } })
      .populate('institutionId departmentId cohortId');
    if (!enr) return res.status(404).json({ success: false, message: 'No placement enrollment' });
    const user = await User.findById(req.user.userId).select('firstName lastName phone');
    const obj = await UserObjective.findOne({ userId: req.user.userId, 'institutionContext.cohortId': enr.cohortId ? enr.cohortId._id : enr.cohortId });
    const competencies = (obj && obj.analysis && Array.isArray(obj.analysis.competencies))
      ? obj.analysis.competencies.map((c) => ({ name: c.name, category: c.category || 'core' }))
      : [];
    return res.json({ success: true, data: {
      name: user ? [user.firstName, user.lastName].filter(Boolean).join(' ') || null : null,
      phone: user ? (user.phone || null) : null,
      rollNumber: enr.rollNumber || null,
      institution: enr.institutionId ? enr.institutionId.name : null,
      branch: enr.departmentId ? enr.departmentId.name : null,
      year: enr.cohortId ? enr.cohortId.year : null,
      cohortLabel: enr.cohortId ? enr.cohortId.label : null,
      objectiveLabel: obj ? ((obj.specifics && obj.specifics.targetRole) || null) : null,
      competencies,
    } });
  } catch (err) {
    console.error('[v2/me/placement-onboarding] error', err);
    return res.status(500).json({ success: false, message: 'Could not load onboarding details' });
  }
});

// Student assessment routes — list scheduled assessments, start, sync.
// The studentAssessments router manages its own auth per-handler (same D2C `auth`).
// Mounted here so final paths are /api/v2/me/assessments/*.
router.use('/', require('../institution/studentAssessments'));

module.exports = router;
