const router = require('express').Router();
const ctrl = require('../controllers/userInferenceController');
const auth = require('../middleware/auth');

router.use(auth);

router.get('/', ctrl.list);
router.put('/:key/resolve', ctrl.resolve);

module.exports = router;
