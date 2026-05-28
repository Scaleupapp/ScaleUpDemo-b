'use strict';

const router = require('express').Router();
const auth = require('../../middleware/auth');
const ctl = require('../controllers/compassCoder.controller');

router.post('/chat', auth, ctl.chat);
router.post('/turn', auth, ctl.turn);
router.post('/resolve', auth, ctl.resolve);
router.get('/budget', auth, ctl.getBudget);

module.exports = router;
