/**
 * v2 Opt-in sync.
 *
 *   POST /api/v2/opt-in/v2  { enabled: Boolean }
 *
 * Mirrors the client-side V2FeatureFlag onto the User document so server-side
 * workers (notification cron, etc.) know to demote v1 anti-thesis prompts
 * (streak-panic, generic-trending) for this user.
 */
const express = require('express');
const auth = require('../../middleware/auth');
const User = require('../../models/User');

const router = express.Router();

router.post('/v2', auth, async (req, res) => {
  try {
    const { enabled } = req.body || {};
    const userId = req.user.userId;
    await User.updateOne(
      { _id: userId },
      {
        $set: {
          v2OptedIn: !!enabled,
          v2OptedInAt: enabled ? new Date() : null,
        },
      }
    );
    return res.json({ success: true, data: { v2OptedIn: !!enabled } });
  } catch (err) {
    console.error('[v2/opt-in/v2] error', err);
    return res.status(500).json({ success: false, message: 'Failed to update opt-in' });
  }
});

module.exports = router;
