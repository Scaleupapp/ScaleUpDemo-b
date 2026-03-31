const router = require('express').Router();
const ctrl = require('../controllers/collegeController');
const auth = require('../middleware/auth');

// GET /api/v1/colleges/search?q=iim&limit=15
router.get('/search', auth, ctrl.searchColleges);

module.exports = router;
