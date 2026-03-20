require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  // Check for creator applications collection
  const collections = await db.listCollections().toArray();
  const collNames = collections.map(c => c.name);
  console.log('Collections:', collNames.filter(n => n.match(/creator|applic|request|role/i)).join(', ') || 'none matching creator/application');

  // Check users with pending creator status
  const users = await db.collection('users').find({
    $or: [
      { creatorStatus: 'pending' },
      { 'creatorApplication.status': 'pending' },
      { role: 'pending_creator' },
    ]
  }).toArray();
  console.log(`\nPending creator users: ${users.length}`);
  for (const u of users) {
    console.log(JSON.stringify({ id: u._id, name: `${u.firstName} ${u.lastName}`, email: u.email, role: u.role, creatorStatus: u.creatorStatus, creatorApplication: u.creatorApplication }));
  }

  // Also check if there's a separate applications collection
  if (collNames.includes('creatorapplications')) {
    const apps = await db.collection('creatorapplications').find({ status: 'pending' }).toArray();
    console.log(`\nPending in creatorapplications collection: ${apps.length}`);
    for (const a of apps) {
      console.log(JSON.stringify(a));
    }
  }

  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
