/**
 * v2 Compass routes — the single AI entry point.
 *
 *   POST /api/v2/compass            — mode-routed AI orchestration
 *   GET  /api/v2/compass/thread     — fetch active conversation thread
 *   POST /api/v2/compass/reset      — archive current thread, start fresh
 *   GET  /api/v2/compass/usage      — today's token usage vs cap
 */
const express = require('express');
const auth = require('../../middleware/auth');
const orchestrator = require('../../services/v2/compassOrchestrator');

const router = express.Router();

router.post('/', auth, async (req, res) => {
  const { mode = 'greeting', payload = {} } = req.body || {};
  try {
    const result = await orchestrator.handle({ userId: req.user.userId, mode, payload });
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('[v2/compass] error', err);
    return res.status(500).json({ success: false, message: 'Compass error' });
  }
});

router.get('/thread', auth, async (req, res) => {
  try {
    const thread = await orchestrator.getActiveThread(req.user.userId);
    return res.json({ success: true, data: thread });
  } catch (err) {
    console.error('[v2/compass/thread] error', err);
    return res.status(500).json({ success: false, message: 'Failed to load thread' });
  }
});

router.post('/reset', auth, async (req, res) => {
  try {
    const result = await orchestrator.resetActiveThread(req.user.userId);
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('[v2/compass/reset] error', err);
    return res.status(500).json({ success: false, message: 'Failed to reset' });
  }
});

router.get('/usage', auth, async (req, res) => {
  try {
    const usage = await orchestrator.getBudgetUsage(req.user.userId);
    return res.json({ success: true, data: usage });
  } catch (err) {
    console.error('[v2/compass/usage] error', err);
    return res.status(500).json({ success: false, message: 'Failed to read usage' });
  }
});

module.exports = router;
