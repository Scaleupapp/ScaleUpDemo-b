/**
 * v2 Opt-in.
 *
 *   POST /api/v2/opt-in/v2  { enabled: Boolean }
 *
 * Called when an existing user accepts the "try v2" prompt. Sets v2OptedIn so
 * server-side workers demote v1 anti-thesis prompts for them, and sets
 * v2NeedsOnboarding so the client routes them through the v2 onboarding flow
 * (re-onboard — their learning history is kept, only the active objective/plan
 * is replaced). There is no path back to v1 once opted in.
 */
const express = require('express');
const auth = require('../../middleware/auth');
const User = require('../../models/User');

const router = express.Router();

router.post('/v2', auth, async (req, res) => {
  try {
    const { enabled } = req.body || {};
    const userId = req.user.userId;
    const on = !!enabled;
    await User.updateOne(
      { _id: userId },
      {
        $set: {
          v2OptedIn: on,
          v2OptedInAt: on ? new Date() : null,
          // Accepting v2 always means re-onboarding into the v2 flow.
          v2NeedsOnboarding: on,
        },
      }
    );
    return res.json({ success: true, data: { v2OptedIn: on, needsOnboarding: on } });
  } catch (err) {
    console.error('[v2/opt-in/v2] error', err);
    return res.status(500).json({ success: false, message: 'Failed to update opt-in' });
  }
});

module.exports = router;
