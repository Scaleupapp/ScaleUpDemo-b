const { execFile } = require('child_process');
execFile('ffmpeg', ['-version'], (err, stdout) => {
  if (err) {
    console.log('ffmpeg NOT found:', err.message);
  } else {
    console.log('ffmpeg found:', stdout.split('\n')[0]);
  }
});

// Also check failed jobs in Redis
require('dotenv').config();
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL);
(async () => {
  // Check failed jobs in whisperTranscription queue
  const failed = await redis.lrange('bull:whisperTranscription:failed', 0, 5);
  console.log('Failed whisper jobs:', failed.length);
  for (const j of failed) {
    try {
      const parsed = JSON.parse(j);
      console.log('  -', parsed.failedReason || parsed.stacktrace?.[0]?.slice(0, 200));
    } catch { console.log('  - raw:', j.slice(0, 200)); }
  }
  await redis.quit();
})();
