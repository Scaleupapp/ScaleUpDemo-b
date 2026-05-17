// src/routes/competition.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const rbac = require('../middleware/rbac');
const c = require('../controllers/competitionController');

// Daily Challenges
router.get('/challenges/today', auth, c.getTodayChallenges);
router.get('/challenges/:id', auth, c.getChallengeById);
router.post('/challenges/:id/start', auth, c.startChallenge);
router.put('/challenges/:id/answer', auth, c.submitChallengeAnswer);
router.post('/challenges/:id/complete', auth, c.completeChallenge);
router.get('/challenges/:id/results', auth, c.getChallengeResults);
router.get('/challenges/:id/review', auth, c.getChallengeReview);

// Leaderboard
router.get('/leaderboard/weekly', auth, c.getWeeklyLeaderboard);
router.get('/leaderboard/alltime', auth, c.getAllTimeLeaderboard);

// Objective Topic
router.get('/objective-topic', auth, c.getObjectiveTopic);
// V2: per-user "what's relevant right now" — challenge + next live event.
router.get('/relevant', auth, c.getRelevantForUser);

// Profile & Stats
router.get('/profile', auth, c.getCompetitionProfile);
router.get('/stats', auth, c.getCompetitionStats);
// V2: user's past competition attempts, newest first.
router.get('/history', auth, c.getCompetitionHistory);

// Live Events
router.get('/live-events/upcoming', auth, c.getUpcomingEvents);
router.get('/live-events/:id', auth, c.getEventById);
router.post('/live-events/:id/join', auth, c.joinLobby);
router.get('/live-events/:id/lobby', auth, c.getLobbyState);
router.get('/live-events/:id/question', auth, c.getCurrentQuestion);
router.put('/live-events/:id/answer', auth, c.submitLiveAnswer);
router.get('/live-events/:id/question-results', auth, c.getQuestionResults);
router.get('/live-events/:id/results', auth, c.getEventResults);

// Admin
router.get('/admin/challenge-candidates', auth, rbac('admin'), c.getChallengeCandidates);
router.put('/admin/challenge-candidates/:id', auth, rbac('admin'), c.approveCandidates);
router.post('/admin/challenges/generate', auth, rbac('admin'), c.triggerGeneration);

module.exports = router;
