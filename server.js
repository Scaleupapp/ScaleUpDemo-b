require('dotenv').config();
const http = require('http');
const app = require('./src/app');
const connectDB = require('./src/config/db');
const { startWorkers } = require('./src/workers/index');
const capstoneSessionRoom = require('./src/coding/websocket/sessionRoom');

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
  // Create an explicit http server so the WebSocket attach() below can
  // hook the upgrade handler before the app starts accepting connections.
  const server = http.createServer(app);
  capstoneSessionRoom.attach(server);
  server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
})();
