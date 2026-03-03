const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const compression = require('compression');
const errorHandler = require('./middleware/errorHandler');

const app = express();

// Disable ETags — prevents 304 empty-body responses that break mobile clients
app.set('etag', false);

// --- Global Middleware ---
app.use(helmet());
app.use(cors());
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

// --- Health Check ---
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// --- Error Handler (must be last) ---
app.use(errorHandler);

module.exports = app;
