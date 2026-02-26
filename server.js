require('dotenv').config();
const app = require('./src/app');
const connectDB = require('./src/config/db');
const { startWorkers } = require('./src/workers/index');

const PORT = process.env.PORT || 5000;

// Catch unhandled errors so they don't silently kill requests
process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

(async () => {
  await connectDB();
  startWorkers();
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
})();
