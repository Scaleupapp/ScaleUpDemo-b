const router = require('express').Router();
const ctrl = require('../controllers/todayController');
const auth = require('../middleware/auth');

router.use(auth);
router.get('/summary', ctrl.getSummary);
router.post('/intent', ctrl.processIntent);

module.exports = router;
