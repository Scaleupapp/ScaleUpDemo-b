'use strict';

const router = require('express').Router();
const auth = require('../../middleware/auth');
const rl = require('../middleware/codingRateLimit');
const ctl = require('../controllers/compassCoder.controller');

/**
 * Rate-limit policy (per-user):
 *   - chat: 40/min (Phase A refactor-drill conversational flow)
 *   - turn: 20/min — tool-use loops are expensive; daily-budget caps further
 *   - resolve: 60/min — UI taps are lightweight
 *   - budget: 120/min — read-only
 */

router.post('/chat',    auth, rl({ endpoint: 'coder-chat',    max: 40 }), ctl.chat);
router.post('/turn',    auth, rl({ endpoint: 'coder-turn',    max: 20 }), ctl.turn);
router.post('/resolve', auth, rl({ endpoint: 'coder-resolve', max: 60 }), ctl.resolve);
router.get('/budget',   auth, rl({ endpoint: 'coder-budget',  max: 120 }), ctl.getBudget);

module.exports = router;
