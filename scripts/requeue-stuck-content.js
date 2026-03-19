/**
 * Re-queue stuck content for transcription + AI processing.
 * Run after ffmpeg is installed.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Content = require('../src/models/Content');
const { whisperTranscriptionQueue, contentProcessingQueue } = require('../src/config/queue');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);

  const stuck = await Content.find({
    sourceType: 'original',
    status: 'processing',
    aiStatus: 'pending',
  });

  console.log(`Found ${stuck.length} stuck content items`);

  for (const doc of stuck) {
    if (doc.contentType === 'video' && doc.s3Key) {
      await whisperTranscriptionQueue.add('transcribe', { contentId: doc._id.toString() });
      console.log(`  Queued transcription: ${doc.title}`);
    } else {
      await contentProcessingQueue.add('process', { contentId: doc._id.toString() });
      console.log(`  Queued processing: ${doc.title}`);
    }
  }

  console.log('Done');
  // Give BullMQ time to enqueue
  await new Promise(r => setTimeout(r, 2000));
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
