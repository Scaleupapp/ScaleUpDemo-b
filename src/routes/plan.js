const router = require('express').Router();
const ctrl = require('../controllers/planController');
const auth = require('../middleware/auth');

router.use(auth);

router.get('/status', ctrl.getStatus);
router.get('/current', ctrl.getCurrent);

module.exports = router;
