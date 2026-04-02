const router = require('express').Router();
const ctrl = require('../controllers/noteRequestController');
const auth = require('../middleware/auth');

router.use(auth);

router.post('/', ctrl.createRequest);
router.get('/', ctrl.listRequests);
router.get('/mine', ctrl.getMyRequests);
router.get('/:id', ctrl.getRequest);
router.post('/:id/upvote', ctrl.toggleUpvote);
router.post('/:id/claim', ctrl.claimRequest);
router.post('/:id/fulfill', ctrl.fulfillRequest);
router.delete('/:id', ctrl.deleteRequest);

module.exports = router;
