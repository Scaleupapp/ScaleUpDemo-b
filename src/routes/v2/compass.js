/**
 * v2 Compass routes — the single AI entry point.
 *
 *   POST /api/v2/compass — body: { mode, payload }
 *
 * Mode-based dispatch. All AI features share this entry. Replaces the need for
 * iOS to call /tutor, /quizzes/request, /interviews/start, /notes/request-upload
 * separately during a conversational flow. (v1 endpoints remain for direct usage.)
 */
const express = require('express');
const auth = require('../../middleware/auth');
const { handle } = require('../../services/v2/compassOrchestrator');

const router = express.Router();

router.post('/', auth, async (req, res) => {
  const { mode = 'greeting', payload = {} } = req.body || {};
  try {
    const result = await handle({ userId: req.user.userId, mode, payload });
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('[v2/compass] error', err);
    return res.status(500).json({ success: false, message: 'Compass error' });
  }
});

module.exports = router;
