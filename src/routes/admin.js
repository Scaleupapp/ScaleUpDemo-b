const router = require('express').Router();
const ctrl = require('../controllers/adminController');
const auth = require('../middleware/auth');
const rbac = require('../middleware/rbac');
const featureFlags = require('../config/featureFlags');

router.use(auth, rbac('admin'));

// Creator applications (admin can view all, endorse, reject)
router.get('/applications', ctrl.getPendingApplications);
router.post('/applications/:id/approve', ctrl.approveApplication);
router.post('/applications/:id/reject', ctrl.rejectApplication);

// User management
router.get('/users', ctrl.getUsers);
router.put('/users/:id/ban', ctrl.banUser);
router.put('/users/:id/unban', ctrl.unbanUser);

// Content moderation
router.get('/content', ctrl.getContent);
router.put('/content/:id/moderate', ctrl.moderateContent);
router.put('/content/:id/remove', ctrl.removeContent);
router.put('/content/:id/dismiss', ctrl.dismissReports);
router.get('/content/:id/reports', ctrl.getContentReports);

// Creator listing + tier promotion
router.get('/creators', ctrl.getCreators);
router.put('/creators/:id/promote', ctrl.promoteCreator);

// Notes moderation
router.get('/notes/pending', ctrl.getPendingNotes);

// Platform stats
router.get('/stats', ctrl.getStats);

// Phase 4B — calibration status + outcome volume per archetype (the "when to flip the flag" dashboard).
// READ-ONLY. Auth already enforced by router.use(auth, rbac('admin')) above.
router.get('/calibration', async (req, res) => {
  try {
    const counts = await require('../services/readiness/calibrationDataService').countsByArchetype();
    const models = await require('../models/CalibrationModel').find({}).lean();
    const byArch = models.reduce((m, d) => { m[d.archetype] = d; return m; }, {});
    const calib = require('../services/readiness/calibrationService');
    const { outcomeCalibratedTarget } = require('../config/featureFlags');

    const archetypes = ['interview', 'exam', 'skill', 'generic'];
    // Union: every archetype that has outcomes OR a persisted model appears.
    const allArchetypes = [...new Set([...archetypes, ...Object.keys(counts), ...Object.keys(byArch)])];
    allArchetypes.sort();

    const archetypeRows = allArchetypes.map((a) => ({
      archetype: a,
      resolvedOutcomes: counts[a] || 0,
      calibrated: !!byArch[a],
      target: byArch[a]?.target ?? null,
      reliabilityN: byArch[a]?.reliabilityN ?? null,
      sampleCount: byArch[a]?.sampleCount ?? null,
      computedAt: byArch[a]?.computedAt ?? null,
    }));

    res.json({
      success: true,
      data: {
        flagOn: outcomeCalibratedTarget,
        minOutcomes: calib.MIN_OUTCOMES_PER_ARCHETYPE,
        threshold: calib.DEFAULT_THRESHOLD,
        archetypes: archetypeRows,
      },
    });
  } catch (err) {
    console.error('[admin/calibration]', err.message);
    res.status(500).json({ success: false, message: 'Could not load calibration status.' });
  }
});

// Employer marketplace — contact-tier approval queue (Hire from ScaleUp, Phase 1)
const employerApproval = require('../services/employer/employerApprovalService');
router.get('/employers/pending', async (req, res) => {
  try {
    if (!featureFlags.employerMarketplace) return res.status(404).json({ success: false, message: 'Not found' });
    return res.json({ success: true, data: await employerApproval.listPending() });
  }
  catch (e) { console.error('[admin/employers/pending]', e.message); return res.status(500).json({ success: false }); }
});
router.post('/employers/:id/approve', async (req, res) => {
  try {
    if (!featureFlags.employerMarketplace) return res.status(404).json({ success: false, message: 'Not found' });
    const updated = await employerApproval.approve(req.params.id, req.user.userId);
    if (!updated) return res.status(404).json({ success: false, message: 'Employer not found' });
    return res.json({ success: true });
  }
  catch (e) { console.error('[admin/employers/approve]', e.message); return res.status(500).json({ success: false }); }
});
router.post('/employers/:id/reject', async (req, res) => {
  try {
    if (!featureFlags.employerMarketplace) return res.status(404).json({ success: false, message: 'Not found' });
    const updated = await employerApproval.reject(req.params.id, req.user.userId);
    if (!updated) return res.status(404).json({ success: false, message: 'Employer not found' });
    return res.json({ success: true });
  }
  catch (e) { console.error('[admin/employers/reject]', e.message); return res.status(500).json({ success: false }); }
});

module.exports = router;
