const router = require('express').Router();
const ctrl = require('../controllers/learningPathController');
const auth = require('../middleware/auth');

router.use(auth);

// Browse
router.get('/explore', ctrl.explorePaths);
router.get('/mine', ctrl.getMyPaths);
router.get('/:id', ctrl.getPath);

// CRUD
router.post('/', ctrl.createPath);
router.put('/:id', ctrl.updatePath);
router.post('/:id/publish', ctrl.publishPath);
router.post('/:id/archive', ctrl.archivePath);

// Items management
router.post('/:id/items', ctrl.addItem);
router.put('/:id/items/reorder', ctrl.reorderItems);
router.delete('/:id/items/:contentId', ctrl.removeItem);

// Engagement
router.post('/:id/follow', ctrl.followPath);
router.delete('/:id/follow', ctrl.unfollowPath);
router.post('/:id/rate', ctrl.ratePath);

module.exports = router;
