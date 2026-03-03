const router = require('express').Router();
const ctrl = require('../controllers/journeyController');
const auth = require('../middleware/auth');

router.use(auth);

router.get('/', ctrl.getActiveJourney);
router.post('/generate', ctrl.generateJourney);
router.get('/today', ctrl.getTodayPlan);
router.get('/week/:weekNumber', ctrl.getWeekPlan);
router.put('/pause', ctrl.pauseJourney);
router.put('/resume', ctrl.resumeJourney);
router.get('/milestones', ctrl.getMilestones);
router.post('/milestones', ctrl.addMilestone);
router.delete('/milestones/:milestoneId', ctrl.deleteMilestone);
router.get('/progress', ctrl.getProgress);
router.get('/adaptations', ctrl.getAdaptations);
router.get('/dashboard', ctrl.getDashboard);
router.put('/assignment/complete', ctrl.completeAssignment);

module.exports = router;
