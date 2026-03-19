require('dotenv').config();
const mongoose = require('mongoose');
const Content = require('../src/models/Content');
async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const docs = await Content.find({ sourceType: 'original' }).select('title status aiStatus s3Key thumbnailURL thumbnailS3Key transcript').lean();
  for (const d of docs) {
    console.log(JSON.stringify({
      title: d.title,
      status: d.status,
      aiStatus: d.aiStatus,
      s3Key: d.s3Key,
      thumbnailURL: d.thumbnailURL,
      hasTranscript: !!(d.transcript && d.transcript.length > 0),
    }));
  }
  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
