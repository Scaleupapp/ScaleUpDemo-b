/**
 * v2 API namespace
 *
 * Co-exists with /api/v1/* — v1 routes remain untouched and operational.
 * v2 surfaces only the new capabilities required for the v2 UX redesign:
 *   - required-time computation
 *   - readiness trajectory forecast
 *   - predicted-impact-per-task estimator
 *   - top-3 leverage actions
 *   - Compass orchestrator (unified AI surface)
 *
 * Rollback strategy: drop the v2 mount in app.js. v1 keeps working.
 */
const express = require('express');
const router = express.Router();

router.use('/objective', require('./objective'));
router.use('/diagnostic', require('./diagnostic'));
router.use('/plan', require('./plan'));
router.use('/compass', require('./compass'));
router.use('/insights', require('./insights'));
router.use('/you/talent/connections', require('./talentConnections'));
router.use('/you/talent', require('./talent'));
router.use('/you', require('./you'));
router.use('/opt-in', require('./optIn'));
router.use('/me', require('./me'));
router.use('/agent', require('./agentDecisions'));

router.get('/health', (_req, res) => res.json({ status: 'ok', namespace: 'v2', ts: new Date() }));

// Public invite lookup for the /join landing page (token comes from the invite
// email link). Unauthed — the token IS the secret. Returns just enough to render
// the page: who invited them, their cohort, and their 6-digit claim code.
router.get('/invite', async (req, res) => {
  try {
    const token = String(req.query.token || '');
    if (!token) return res.status(400).json({ success: false, message: 'Missing token' });
    const PendingStudent = require('../../models/PendingStudent');
    const Institution = require('../../models/Institution');
    const InstitutionCohort = require('../../models/InstitutionCohort');
    const pending = await PendingStudent.findOne({ inviteToken: token });
    if (!pending) return res.status(404).json({ success: false, message: 'Invite not found' });
    const [inst, cohort] = await Promise.all([
      Institution.findById(pending.institutionId).select('name logoUrl brandColor'),
      InstitutionCohort.findById(pending.cohortId).select('label year'),
    ]);
    return res.json({ success: true, data: {
      institutionName: inst ? inst.name : 'Your institution',
      logoUrl: inst ? inst.logoUrl : null,
      brandColor: inst ? inst.brandColor : null,
      cohortLabel: cohort ? cohort.label : null,
      studentName: pending.name || null,
      email: pending.email || null,
      code: pending.claimCode || null,
      claimed: pending.status === 'claimed',
    } });
  } catch (err) {
    console.error('[v2/invite] error', err);
    return res.status(500).json({ success: false, message: 'Could not load the invite' });
  }
});

// Config probe — clients call this at launch to decide v1 vs v2 routing.
// When the V2_API_ENABLED kill switch is off, app.js answers this directly
// (this handler is only reached when v2 IS enabled).
router.get('/config', (_req, res) => res.json({
  success: true,
  data: {
    v2ApiEnabled: true,
    // v2ForNewUsers: flip to true (via env) only after the v2 onboarding
    // rebuild is shipped + tested. Until then fresh users stay on v1.
    v2ForNewUsers: process.env.V2_FOR_NEW_USERS === 'true',
  },
}));

module.exports = router;
