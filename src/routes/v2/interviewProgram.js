'use strict';

/**
 * Interview-coach program endpoints (agentic layer, Plan 5 #4).
 *
 * Thin HTTP shell over interviewProgramService — all the guarding (one-active
 * program, flag gating) lives in the service; this layer just maps service
 * outcomes to the house HTTP/error-envelope conventions (same pattern as
 * agentDecisions.js). Flag off ('interview_coach') returns 404 on all three
 * routes — house convention: clients treat 404 as feature-off.
 */
const express = require('express');
const auth = require('../../middleware/auth');
const interviewProgramService = require('../../services/interviewProgramService');
const { isAgentEnabled } = require('../../config/agentFlags');

/**
 * Handler factory with DI seams (repo test convention: zero DB in tests).
 */
function makeHandlers(deps = {}) {
  const d = {
    isAgentEnabled: deps.isAgentEnabled || isAgentEnabled,
    createProgram: deps.createProgram || interviewProgramService.createProgram,
    getProgram: deps.getProgram || interviewProgramService.getProgram,
    abandonProgram: deps.abandonProgram || interviewProgramService.abandonProgram,
  };

  async function createHandler(req, res) {
    try {
      if (!d.isAgentEnabled('interview_coach')) {
        return res.status(404).json({ success: false, message: 'Not found' });
      }
      const { targetRole, targetCompany, driveDate, weeks } = req.body || {};
      if (!targetRole) {
        return res.status(400).json({ success: false, message: 'targetRole is required' });
      }
      await d.createProgram({
        userId: req.user.userId,
        targetRole,
        targetCompany,
        driveDate,
        weeks,
      });
      const program = await d.getProgram({ userId: req.user.userId });
      return res.json({ success: true, data: { program } });
    } catch (err) {
      if (/already active/i.test(err.message)) return res.status(409).json({ success: false, message: err.message });
      console.error('[v2/interview-program] create error', err);
      return res.status(500).json({ success: false, message: 'Could not create your interview program' });
    }
  }

  async function getHandler(req, res) {
    try {
      if (!d.isAgentEnabled('interview_coach')) {
        return res.status(404).json({ success: false, message: 'Not found' });
      }
      const program = await d.getProgram({ userId: req.user.userId });
      return res.json({ success: true, data: { program } });
    } catch (err) {
      console.error('[v2/interview-program] get error', err);
      return res.status(500).json({ success: false, message: 'Could not load your interview program' });
    }
  }

  async function abandonHandler(req, res) {
    try {
      if (!d.isAgentEnabled('interview_coach')) {
        return res.status(404).json({ success: false, message: 'Not found' });
      }
      const { abandoned } = await d.abandonProgram({ userId: req.user.userId });
      return res.json({ success: true, data: { abandoned } });
    } catch (err) {
      console.error('[v2/interview-program] abandon error', err);
      return res.status(500).json({ success: false, message: 'Could not abandon your interview program' });
    }
  }

  return { createHandler, getHandler, abandonHandler };
}

const router = express.Router();
const handlers = makeHandlers();
router.post('/', auth, handlers.createHandler);
router.get('/', auth, handlers.getHandler);
router.post('/abandon', auth, handlers.abandonHandler);

module.exports = router;
module.exports.makeHandlers = makeHandlers;
