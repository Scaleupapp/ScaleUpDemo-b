const router = require('express').Router();
const ctrl = require('../controllers/authController');
const auth = require('../middleware/auth');
const validate = require('../middleware/validate');
const schemas = require('../validators/authValidators');
const auditLog = require('../middleware/auditLog');
const rateLimiter = require('../middleware/rateLimiter');

// Strict rate limits on auth endpoints to prevent brute force
const loginLimiter = rateLimiter({ windowMs: 15 * 60 * 1000, max: 10, keyPrefix: 'rl:login' });      // 10 attempts per 15 min
const registerLimiter = rateLimiter({ windowMs: 60 * 60 * 1000, max: 5, keyPrefix: 'rl:register' });  // 5 per hour
const otpLimiter = rateLimiter({ windowMs: 60 * 1000, max: 3, keyPrefix: 'rl:otp' });                 // 3 per minute
const resetLimiter = rateLimiter({ windowMs: 15 * 60 * 1000, max: 5, keyPrefix: 'rl:reset' });        // 5 per 15 min

router.post('/register', registerLimiter, validate(schemas.register), auditLog('register', 'auth'), ctrl.register);
router.post('/login', loginLimiter, validate(schemas.login), auditLog('login', 'auth'), ctrl.login);
router.post('/google', loginLimiter, ctrl.googleLogin);
router.post('/refresh-token', ctrl.refreshToken);
router.post('/forgot-password', resetLimiter, validate(schemas.forgotPassword), ctrl.forgotPassword);
router.post('/reset-password', resetLimiter, validate(schemas.resetPassword), ctrl.resetPassword);

// Phone OTP authentication (Twilio)
router.post('/phone/send-otp', otpLimiter, validate(schemas.sendPhoneOTP), ctrl.sendPhoneOTP);
router.post('/phone/verify-otp', loginLimiter, validate(schemas.verifyPhoneOTP), ctrl.verifyPhoneOTP);
router.post('/phone/verify', auth, validate(schemas.verifyPhone), ctrl.verifyPhone);

router.post('/reactivate', loginLimiter, ctrl.reactivate);
router.post('/logout', auth, ctrl.logout);

module.exports = router;
