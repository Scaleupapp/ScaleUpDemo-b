require('dotenv').config();
const mongoose = require('mongoose');

async function migrate() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  const db = mongoose.connection.db;

  // Simple field normalization for these collections
  const simpleCollections = [
    { name: 'dailychallenges', field: 'topic' },
    { name: 'weeklyleaderboards', field: 'topic' },
    { name: 'liveevents', field: 'topic' },
    { name: 'challengecandidatebanks', field: 'topic' },
  ];

  for (const { name, field } of simpleCollections) {
    const result = await db.collection(name).updateMany(
      {},
      [{ $set: { [field]: { $toLower: { $trim: { input: `$${field}` } } } } }]
    );
    console.log(`${name}.${field}: ${result.modifiedCount} normalized`);
  }

  // KnowledgeProfile.topicMastery — array of objects with .topic field
  const profiles = await db.collection('knowledgeprofiles').find({}).toArray();
  let kpCount = 0;
  for (const profile of profiles) {
    if (!profile.topicMastery || !Array.isArray(profile.topicMastery)) continue;
    let changed = false;
    for (const entry of profile.topicMastery) {
      if (entry.topic && entry.topic !== entry.topic.trim().toLowerCase()) {
        entry.topic = entry.topic.trim().toLowerCase();
        changed = true;
      }
    }
    if (changed) {
      await db.collection('knowledgeprofiles').updateOne(
        { _id: profile._id },
        { $set: { topicMastery: profile.topicMastery } }
      );
      kpCount++;
    }
  }
  console.log(`knowledgeprofiles.topicMastery: ${kpCount} normalized`);

  // UserObjective.topicsOfInterest — already has lowercase:true in schema but normalize existing data
  const objectives = await db.collection('userobjectives').find({}).toArray();
  let uoCount = 0;
  for (const obj of objectives) {
    if (!obj.topicsOfInterest || !Array.isArray(obj.topicsOfInterest)) continue;
    const normalized = obj.topicsOfInterest.map(t => t.trim().toLowerCase());
    const changed = obj.topicsOfInterest.some((t, i) => t !== normalized[i]);
    if (changed) {
      await db.collection('userobjectives').updateOne(
        { _id: obj._id },
        { $set: { topicsOfInterest: normalized } }
      );
      uoCount++;
    }
  }
  console.log(`userobjectives.topicsOfInterest: ${uoCount} normalized`);

  console.log('Migration complete');
  await mongoose.disconnect();
}

migrate().catch(err => { console.error(err); process.exit(1); });
