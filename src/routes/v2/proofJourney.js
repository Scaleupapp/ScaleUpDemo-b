'use strict';

/**
 * Proof-builder journey endpoints (agentic layer, Plan 5 #8).
 *
 * Thin HTTP shell over proofJourneyService — all the state-machine logic
 * (extraction, generation kickoff, grade-hook correlation, publish guard,
 * flag gating) lives in the service; this layer just maps service outcomes
 * to the house HTTP/error-envelope conventions (same pattern as
 * interviewProgram.js). Flag off ('proof_builder') returns 404 on all three
 * routes — house convention: clients treat 404 as feature-off.
 */
const express = require('express');
const auth = require('../../middleware/auth');
const proofJourneyService = require('../../services/proofJourneyService');
const { isAgentEnabled } = require('../../config/agentFlags');

/**
 * Handler factory with DI seams (repo test convention: zero DB in tests).
 */
function makeHandlers(deps = {}) {
  const d = {
    isAgentEnabled: deps.isAgentEnabled || isAgentEnabled,
    startJourney: deps.startJourney || proofJourneyService.startJourney,
    getJourney: deps.getJourney || proofJourneyService.getJourney,
    publishProof: deps.publishProof || proofJourneyService.publishProof,
  };

  async function createHandler(req, res) {
    try {
      if (!d.isAgentEnabled('proof_builder')) {
        return res.status(404).json({ success: false, message: 'Not found' });
      }
      const jdText = (req.body || {}).jdText;
      if (!jdText || !String(jdText).trim()) {
        return res.status(400).json({ success: false, message: 'jdText is required' });
      }
      const journey = await d.startJourney({ userId: req.user.userId, jdText });
      return res.json({ success: true, data: { journey } });
    } catch (err) {
      console.error('[v2/proof-journey] create error', err);
      return res.status(500).json({ success: false, message: 'Could not start your proof journey' });
    }
  }

  async function getHandler(req, res) {
    try {
      if (!d.isAgentEnabled('proof_builder')) {
        return res.status(404).json({ success: false, message: 'Not found' });
      }
      const journey = await d.getJourney({ userId: req.user.userId });
      return res.json({ success: true, data: { journey } });
    } catch (err) {
      console.error('[v2/proof-journey] get error', err);
      return res.status(500).json({ success: false, message: 'Could not load your proof journey' });
    }
  }

  async function publishHandler(req, res) {
    try {
      if (!d.isAgentEnabled('proof_builder')) {
        return res.status(404).json({ success: false, message: 'Not found' });
      }
      const journey = await d.publishProof({ userId: req.user.userId });
      return res.json({ success: true, data: { journey } });
    } catch (err) {
      if (/not publishable/i.test(err.message)) {
        return res.status(409).json({ success: false, message: err.message });
      }
      if (/no proof journey found/i.test(err.message)) {
        return res.status(404).json({ success: false, message: err.message });
      }
      console.error('[v2/proof-journey] publish error', err);
      return res.status(500).json({ success: false, message: 'Could not publish your proof' });
    }
  }

  return { createHandler, getHandler, publishHandler };
}

const router = express.Router();
const handlers = makeHandlers();
router.post('/', auth, handlers.createHandler);
router.get('/', auth, handlers.getHandler);
router.post('/publish', auth, handlers.publishHandler);

module.exports = router;
module.exports.makeHandlers = makeHandlers;
