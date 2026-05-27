'use strict';

const router = require('express').Router();
const auth = require('../../middleware/auth');
const capstones = require('../controllers/capstones.controller');
const replay = require('../controllers/capstoneReplay.controller');

/**
 * Capstone routes — mounted at /api/coding/capstones/* by coding/routes/index.js.
 *
 * Order matters: library + start + redeem must be declared BEFORE the
 * /:session_id routes so Express doesn't match e.g. "redeem" as the
 * session_id param.
 */

router.get('/library', auth, capstones.listLibrary);
router.post('/start', auth, capstones.start);
// Redeem is unauthenticated — the laptop posting the code may not have a
// session yet. The code itself is the bearer for this single hop.
router.post('/redeem', capstones.redeemPairing);

router.get('/:session_id/status', auth, capstones.getStatus);
router.post('/:session_id/control', auth, capstones.control);
router.get('/:session_id/result', auth, capstones.getResult);
router.get('/:session_id/replay', auth, replay.getReplay);

// Voice-reflection upload + transcription + Reflection-Quality re-eval is a
// full end-to-end pipeline (multer → S3 → Whisper → Sonnet re-score → Notes
// auto-gen). It lands in WS8 — the route is intentionally not registered
// here so prod traffic can't hit a half-built handler.

module.exports = router;
