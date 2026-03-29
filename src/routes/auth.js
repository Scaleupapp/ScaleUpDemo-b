const router = require('express').Router();
const ctrl = require('../controllers/authController');
const auth = require('../middleware/auth');
const validate = require('../middleware/validate');
const schemas = require('../validators/authValidators');
const auditLog = require('../middleware/auditLog');

router.post('/register', validate(schemas.register), auditLog('register', 'auth'), ctrl.register);
router.post('/login', validate(schemas.login), auditLog('login', 'auth'), ctrl.login);
router.post('/google', ctrl.googleLogin);
router.post('/refresh-token', ctrl.refreshToken);
router.post('/forgot-password', validate(schemas.forgotPassword), ctrl.forgotPassword);
router.post('/reset-password', validate(schemas.resetPassword), ctrl.resetPassword);

// Phone OTP authentication (Twilio)
router.post('/phone/send-otp', validate(schemas.sendPhoneOTP), ctrl.sendPhoneOTP);
router.post('/phone/verify-otp', validate(schemas.verifyPhoneOTP), ctrl.verifyPhoneOTP);
router.post('/phone/verify', auth, validate(schemas.verifyPhone), ctrl.verifyPhone);

router.post('/reactivate', ctrl.reactivate);
router.post('/logout', auth, ctrl.logout);

module.exports = router;
