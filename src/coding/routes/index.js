'use strict';

const router = require('express').Router();

router.get('/health', (req, res) => res.json({ module: 'coding', status: 'ok' }));
router.use('/drills', require('./drills.routes'));

module.exports = router;
