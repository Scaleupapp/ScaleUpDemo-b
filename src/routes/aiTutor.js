const router = require('express').Router();
const ctrl = require('../controllers/aiTutorController');
const auth = require('../middleware/auth');

// Get all user's tutor conversations (history)
router.get('/conversations', auth, ctrl.listConversations);

// Check tutor availability for a content item
router.get('/:contentId/status', auth, ctrl.getTutorStatus);

// Get or create conversation for a content item
router.get('/:contentId', auth, ctrl.getConversation);

// Send a message in the tutor chat
router.post('/:contentId/message', auth, ctrl.sendMessage);

// Delete a conversation
router.delete('/:contentId', auth, ctrl.deleteConversation);

module.exports = router;
