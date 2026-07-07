const router = require('express').Router();
const ctrl = require('../controllers/socialController');
const auth = require('../middleware/auth');

router.use(auth);

// Follow
router.post('/follow/:userId', ctrl.followUser);
router.delete('/follow/:userId', ctrl.unfollowUser);
router.get('/followers/:userId', ctrl.getFollowers);
router.get('/following/:userId', ctrl.getFollowing);

// Moderation — block abusive users & report objectionable content
router.get('/blocked', ctrl.getBlocked);
router.post('/block/:userId', ctrl.blockUser);
router.delete('/block/:userId', ctrl.unblockUser);
router.post('/report', ctrl.reportTarget);

// Comments
router.put('/comments/:commentId', ctrl.editComment);
router.delete('/comments/:commentId', ctrl.deleteComment);
router.post('/comments/:commentId/like', ctrl.toggleCommentLike);
router.get('/comments/:commentId/replies', ctrl.getReplies);

// Playlists
router.post('/playlists', ctrl.createPlaylist);
router.get('/playlists', ctrl.getMyPlaylists);
router.get('/playlists/:playlistId', ctrl.getPlaylist);
router.put('/playlists/:playlistId', ctrl.updatePlaylist);
router.post('/playlists/:playlistId/items', ctrl.addToPlaylist);
router.delete('/playlists/:playlistId/items/:contentId', ctrl.removeFromPlaylist);
router.delete('/playlists/:playlistId', ctrl.deletePlaylist);

module.exports = router;
