const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const compression = require('compression');
const errorHandler = require('./middleware/errorHandler');

const app = express();

// Trust the single nginx proxy in front of Node — makes req.ip resolve to the real client IP
// (previously all traffic shared req.ip = ::ffff:127.0.0.1, causing rate limiter to lock out everyone)
app.set('trust proxy', 1);

// Disable ETags — prevents 304 empty-body responses that break mobile clients
app.set('etag', false);

// --- Global Middleware ---
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',')
    : ['https://scaleupapp.club', 'https://www.scaleupapp.club', 'https://api.scaleupapp.club', 'http://scaleupapp.club', 'http://localhost:3000'],
  credentials: true,
}));
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(compression());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request timeout — return 504 if handler doesn't respond in 30 seconds
app.use((req, res, next) => {
  req.setTimeout(30000, () => {
    if (!res.headersSent) {
      console.error(`[TIMEOUT] ${req.method} ${req.originalUrl} — 30s exceeded`);
      res.status(504).json({ success: false, message: 'Request timeout' });
    }
  });
  next();
});

// --- Routes ---
app.use('/api/v1/auth', require('./routes/auth'));
app.use('/api/v1/onboarding', require('./routes/onboarding'));
app.use('/api/v1/objectives', require('./routes/objectives'));
app.use('/api/v1/creator', require('./routes/creator'));
app.use('/api/v1/content', require('./routes/content'));
app.use('/api/v1/progress', require('./routes/progress'));
app.use('/api/v1/quizzes', require('./routes/quizzes'));
app.use('/api/v1/knowledge', require('./routes/knowledge'));
app.use('/api/v1/journey', require('./routes/journey'));
app.use('/api/v1/dashboard', require('./routes/dashboard'));
app.use('/api/v1/social', require('./routes/social'));
app.use('/api/v1/users', require('./routes/users'));
app.use('/api/v1/learning-paths', require('./routes/learningPaths'));
app.use('/api/v1/youtube', require('./routes/youtube'));
app.use('/api/v1/recommendations', require('./routes/recommendations'));
app.use('/api/v1/admin', require('./routes/admin'));
app.use('/api/v1/tutor', require('./routes/aiTutor'));
app.use('/api/v1/notifications', require('./routes/notifications'));
app.use('/api/v1/competition', require('./routes/competition'));
app.use('/api/v1/privacy', require('./routes/gdpr'));
app.use('/api/v1/legal', require('./routes/legal'));
app.use('/api/v1/website', require('./routes/website'));
app.use('/api/v1/colleges', require('./routes/colleges'));
app.use('/api/v1/notes', require('./routes/notes'));
app.use('/api/v1/flashcards', require('./routes/flashcards'));
app.use('/api/v1/mindmaps', require('./routes/mindmaps'));
app.use('/api/v1/audio-summaries', require('./routes/audioSummaries'));
app.use('/api/v1/note-requests', require('./routes/noteRequests'));
app.use('/api/v1/interviews', require('./routes/interviews'));

// --- Health Check ---
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// --- Error Handler (must be last) ---
app.use(errorHandler);

module.exports = app;
