#!/usr/bin/env node

/**
 * Batch AI Processing V2 — Lower concurrency, retry on abort
 *
 * Usage: node scripts/batchAIProcessV2.js
 *
 * Same as batchAIProcess.js but concurrency 2 and 2 retries per video
 * to handle Whisper API abort errors seen with concurrency 5.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const os = require('os');
const { pipeline } = require('stream/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');
const mongoose = require('mongoose');
const OpenAI = require('openai');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const Content = require('../src/models/Content');

const execFileAsync = promisify(execFile);
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const CONCURRENCY = 2;
const MAX_RETRIES = 2;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 180000, // 3 min per request
  maxRetries: 0,   // we handle retries ourselves
});

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const CONTENT_ANALYSIS_PROMPT = `You are an educational content analyzer. Analyze the following content and extract:

1. summary: A 2-3 sentence summary (max 500 chars)
2. keyConcepts: Array of key concepts, each with:
   - concept: The concept name
   - description: Brief explanation
   - timestamp: Where in the content this appears ("MM:SS" for video, "Para X" for text)
   - importance: 1-5 rating
3. prerequisites: Array of topics the viewer should already know
4. qualityScore: 0-100 rating of content quality (clarity, accuracy, depth)
5. autoTags: Array of relevant tags for discoverability
6. difficulty: "beginner", "intermediate", or "advanced"
7. moderationFlags: Array of any content concerns (empty if none)

Return valid JSON only.`;

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatElapsed(startMs) {
  const elapsed = Math.floor((Date.now() - startMs) / 1000);
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return `${m}m${String(s).padStart(2, '0')}s`;
}

async function downloadFromS3(key, outputPath) {
  const command = new GetObjectCommand({
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key,
  });
  const response = await s3.send(command);
  const writeStream = fs.createWriteStream(outputPath);
  await pipeline(response.Body, writeStream);
}

async function extractAudio(videoPath, audioPath) {
  await execFileAsync(FFMPEG_PATH, [
    '-i', videoPath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-b:a', '64k',
    '-f', 'mp3',
    '-y',
    audioPath,
  ], { timeout: 300000 });
}

async function transcribeWithWhisper(audioPath, attempt = 1) {
  try {
    return await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: 'whisper-1',
      language: 'en',
      response_format: 'text',
    });
  } catch (err) {
    if (attempt < MAX_RETRIES && (err.message?.includes('aborted') || err.message?.includes('ECONNRESET') || err.message?.includes('timeout'))) {
      console.log(`  Whisper retry ${attempt}/${MAX_RETRIES}: ${err.message}`);
      await new Promise(r => setTimeout(r, 3000 * attempt));
      return transcribeWithWhisper(audioPath, attempt + 1);
    }
    throw err;
  }
}

async function processWithGPT(content) {
  const contentText = content.transcript || content.description || '';
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: CONTENT_ANALYSIS_PROMPT },
      { role: 'user', content: `Title: ${content.title}\nDomain: ${content.domain}\nTopics: ${(content.topics || []).join(', ')}\nContent:\n${contentText.slice(0, 15000)}` },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.3,
  });
  return JSON.parse(response.choices[0].message.content);
}

async function processOne(content, index, total) {
  const prefix = `[${index}/${total}]`;
  const tmpDir = os.tmpdir();
  const ts = Date.now();
  const videoPath = path.join(tmpDir, `batchv2-video-${content._id}-${ts}.mp4`);
  const audioPath = path.join(tmpDir, `batchv2-audio-${content._id}-${ts}.mp3`);

  try {
    if (!content.transcript || content.transcript.trim().length === 0) {
      if (!content.s3Key) {
        console.log(`${prefix} SKIP (no S3 key): "${content.title}"`);
        return 'skipped';
      }

      await downloadFromS3(content.s3Key, videoPath);
      await extractAudio(videoPath, audioPath);

      const audioStats = fs.statSync(audioPath);
      if (audioStats.size > 25 * 1024 * 1024) {
        console.log(`${prefix} SKIP (audio too large): "${content.title}"`);
        return 'skipped';
      }
      if (audioStats.size < 1024) {
        console.log(`${prefix} SKIP (audio too small): "${content.title}"`);
        return 'skipped';
      }

      const transcript = await transcribeWithWhisper(audioPath);
      if (!transcript || transcript.trim().length === 0) {
        console.log(`${prefix} SKIP (empty transcript): "${content.title}"`);
        return 'skipped';
      }

      content.transcript = transcript;
      await content.save();
    }

    content.aiStatus = 'processing';
    await content.save();

    const analysis = await processWithGPT(content);

    content.aiData = {
      summary: analysis.summary,
      keyConcepts: analysis.keyConcepts || [],
      prerequisites: analysis.prerequisites || [],
      qualityScore: analysis.qualityScore,
      autoTags: analysis.autoTags || [],
      moderationFlags: analysis.moderationFlags || [],
      processedAt: new Date(),
    };
    content.aiStatus = 'completed';
    content.difficulty = analysis.difficulty || content.difficulty;
    await content.save();

    console.log(`${prefix} ✓ "${content.title}" (${formatDuration(content.duration)}) — transcript: ${content.transcript.length} chars, quality: ${analysis.qualityScore}/100`);
    return 'completed';

  } catch (err) {
    console.error(`${prefix} FAIL: "${content.title}" — ${err.message}`);
    content.aiStatus = 'failed';
    await content.save();
    return 'failed';

  } finally {
    try { fs.unlinkSync(videoPath); } catch {}
    try { fs.unlinkSync(audioPath); } catch {}
  }
}

async function runWithConcurrency(items, concurrency, fn) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i + 1, items.length);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function main() {
  if (!process.env.MONGODB_URI) { console.error('MONGODB_URI not set'); process.exit(1); }
  if (!process.env.OPENAI_API_KEY) { console.error('OPENAI_API_KEY not set'); process.exit(1); }
  if (!process.env.S3_BUCKET_NAME) { console.error('S3_BUCKET_NAME not set'); process.exit(1); }

  console.log('='.repeat(60));
  console.log('  Batch AI Processing V2 (concurrency 2, retries)');
  console.log('='.repeat(60));
  console.log();

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('MongoDB connected.\n');

  // Include both 'pending' and 'failed' so we can retry failures from V1
  const pending = await Content.find({
    aiStatus: { $in: ['pending', 'failed'] },
    contentType: 'video',
  }).sort({ createdAt: 1 });

  console.log(`Found ${pending.length} pending/failed content pieces.`);
  console.log(`Concurrency: ${CONCURRENCY}, Max retries: ${MAX_RETRIES}`);
  console.log(`Estimated time: ~${Math.ceil(pending.length / CONCURRENCY * 2)} minutes\n`);

  const startTime = Date.now();
  const results = await runWithConcurrency(pending, CONCURRENCY, processOne);

  const completed = results.filter(r => r === 'completed').length;
  const skipped = results.filter(r => r === 'skipped').length;
  const failed = results.filter(r => r === 'failed').length;

  console.log('\n' + '='.repeat(60));
  console.log('  BATCH COMPLETE');
  console.log('='.repeat(60));
  console.log(`  Completed:  ${completed}`);
  console.log(`  Skipped:    ${skipped}`);
  console.log(`  Failed:     ${failed}`);
  console.log(`  Time:       ${formatElapsed(startTime)}`);
  console.log('='.repeat(60));

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  mongoose.disconnect().finally(() => process.exit(1));
});
