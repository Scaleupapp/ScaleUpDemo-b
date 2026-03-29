const router = require('express').Router();
const ctrl = require('../controllers/gdprController');
const auth = require('../middleware/auth');
const auditLog = require('../middleware/auditLog');

router.use(auth);

// Data export (Article 15 & 20)
router.get('/export', auditLog('data_export', 'data'), ctrl.exportData);

// Consent management
router.get('/consent', ctrl.getConsent);
router.put('/consent', auditLog('consent_update', 'consent'), ctrl.updateConsent);
router.post('/consent/withdraw', auditLog('consent_withdraw', 'consent'), ctrl.withdrawConsent);

// Audit log (self-service)
router.get('/audit-log', ctrl.getMyAuditLog);

// Breach notification (admin only)
router.post('/breach-notify', auditLog('breach_notification', 'security'), ctrl.notifyBreach);

module.exports = router;
