const router = require('express').Router();
const ctrl = require('../controllers/objectiveController');
const auth = require('../middleware/auth');

router.use(auth);
router.get('/', ctrl.getObjectives);
router.post('/', ctrl.createObjective);
router.put('/:id', ctrl.updateObjective);
router.put('/:id/pause', ctrl.pauseObjective);
router.put('/:id/resume', ctrl.resumeObjective);
router.put('/:id/set-primary', ctrl.setPrimary);

module.exports = router;
