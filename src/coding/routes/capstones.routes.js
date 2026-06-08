'use strict';

const router = require('express').Router();
const auth = require('../../middleware/auth');
const rl = require('../middleware/codingRateLimit');
const capstones = require('../controllers/capstones.controller');
const replay = require('../controllers/capstoneReplay.controller');
const voiceReflection = require('../controllers/voiceReflection.controller');
const shareProfile = require('../controllers/shareProfile.controller');

/**
 * Capstone routes — mounted at /api/coding/capstones/* by coding/routes/index.js.
 *
 * Order matters: library + start + redeem must be declared BEFORE the
 * /:session_id routes so Express doesn't match e.g. "redeem" as the
 * session_id param.
 *
 * Rate-limit policy (keyed by userId — see codingRateLimit.js):
 *   - Read endpoints (status/result/replay/library): 120/min
 *   - Start (mints session + sandbox): 6/min — one capstone takes 60–90 min
 *   - Redeem: 20/min keyed by IP (no userId yet at this point)
 *   - Control: 30/min — pause/resume are user-driven, not auto-triggered
 *   - Events: 60/min — recording client flushes every 5s, so 12/min typical
 *   - Run: 40/min — terminal commands; cap protects sandbox cost
 *   - Files: 60/min — debounced editor pushes; cap is a safety net
 *   - Voice reflection: 4/hour — one upload per session is the prod path
 */

router.get('/library', auth, rl({ endpoint: 'library', max: 120 }), capstones.listLibrary);
router.get('/summary', auth, rl({ endpoint: 'summary', max: 120 }), capstones.getSummary);
router.get('/history', auth, rl({ endpoint: 'history', max: 60 }), capstones.getHistory);
router.get('/track', auth, rl({ endpoint: 'track', max: 60 }), capstones.getTrack);
// Recruiter share (authed management; public read lives in publicProfiles.routes.js)
router.post('/share', auth, rl({ endpoint: 'share-create', max: 10 }), shareProfile.createShare);
router.get('/share', auth, rl({ endpoint: 'share-list', max: 60 }), shareProfile.listShares);
router.delete('/share/:tokenId', auth, rl({ endpoint: 'share-revoke', max: 20 }), shareProfile.revokeShare);
router.post('/start', auth, rl({ endpoint: 'start', max: 6 }), capstones.start);
router.post('/retry', auth, rl({ endpoint: 'retry', max: 6 }), capstones.retry);
router.post('/request', auth, rl({ endpoint: 'request', max: 12 }), capstones.requestNext);
// Generator: open to all eligible learners, 5/hour cap (LLM + sandbox cost).
router.post('/generate', auth, rl({ endpoint: 'generate', windowMs: 60 * 60 * 1000, max: 5 }), capstones.generateCapstone);
router.get('/generations', auth, rl({ endpoint: 'generations-list', max: 120 }), capstones.listGenerations);
router.get('/generations/:request_id', auth, rl({ endpoint: 'generation-status', max: 120 }), capstones.getGenerationStatus);
router.post(
  '/redeem',
  rl({ endpoint: 'redeem', max: 20, keyFn: (req) => req.ip || 'anon' }),
  capstones.redeemPairing
);

router.get('/:session_id/status', auth, rl({ endpoint: 'status', max: 120 }), capstones.getStatus);
router.post('/:session_id/rejoin', auth, rl({ endpoint: 'rejoin', max: 10 }), capstones.rejoin);
router.post('/:session_id/control', auth, rl({ endpoint: 'control', max: 30 }), capstones.control);
router.post('/:session_id/events', auth, rl({ endpoint: 'events', max: 60 }), capstones.appendEvents);
router.post('/:session_id/run', auth, rl({ endpoint: 'run', max: 40 }), capstones.runInSandbox);
router.post('/:session_id/files', auth, rl({ endpoint: 'files', max: 60 }), capstones.persistFiles);
router.get('/:session_id/result', auth, rl({ endpoint: 'result', max: 120 }), capstones.getResult);
router.get('/:session_id/latest-snapshot', auth, rl({ endpoint: 'latest-snapshot', max: 60 }), capstones.getLatestSnapshot);
router.get('/:session_id/replay', auth, rl({ endpoint: 'replay', max: 60 }), replay.getReplay);

router.post(
  '/:session_id/voice-reflection',
  auth,
  rl({ endpoint: 'voice-reflection', windowMs: 60 * 60 * 1000, max: 4 }),
  voiceReflection.audioUpload,
  voiceReflection.uploadVoiceReflection
);

module.exports = router;
