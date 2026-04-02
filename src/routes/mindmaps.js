const router = require('express').Router();
const ctrl = require('../controllers/mindMapController');
const auth = require('../middleware/auth');

router.use(auth);

router.post('/generate', ctrl.generateMindMap);
router.get('/', ctrl.listMindMaps);
router.get('/:id', ctrl.getMindMap);
router.delete('/:id', ctrl.deleteMindMap);

module.exports = router;
