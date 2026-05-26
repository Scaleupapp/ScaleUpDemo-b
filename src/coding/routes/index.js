'use strict';

const router = require('express').Router();

router.get('/health', (req, res) => res.json({ module: 'coding', status: 'ok' }));

module.exports = router;
