require('dotenv').config();
const mongoose = require('mongoose');
const Content = require('../src/models/Content');
async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const docs = await Content.find({}).select('title thumbnailURL thumbnailS3Key sourceType').lean();
  for (const d of docs) {
    if (d.thumbnailURL || d.thumbnailS3Key) {
      console.log(JSON.stringify({ title: d.title, thumbnailURL: d.thumbnailURL ? 'SET' : null, thumbnailS3Key: d.thumbnailS3Key || null, sourceType: d.sourceType }));
    }
  }
  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
