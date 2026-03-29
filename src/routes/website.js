const router = require('express').Router();
const ctrl = require('../controllers/websiteController');
const rateLimiter = require('../middleware/rateLimiter');

// Rate limit: 5 submissions per 15 minutes per IP
const formLimiter = rateLimiter({ windowMs: 15 * 60 * 1000, max: 5, keyPrefix: 'rl:website' });

router.post('/feedback', formLimiter, ctrl.submitFeedback);

module.exports = router;
