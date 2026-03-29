require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const creatorId = '699d8af0a7eb4b450fbd22f2';
  const oid = new mongoose.Types.ObjectId(creatorId);

  // Step 1: Check CreatorProfile
  const profile = await db.collection('creatorprofiles').findOne({ userId: oid });
  console.log('CreatorProfile:', profile ? JSON.stringify({ tier: profile.tier, domain: profile.domain, isVerified: profile.isVerified }) : 'NOT FOUND');

  // Step 2: Check User with the exact query from getCreatorPublicProfile
  const user = await db.collection('users').findOne({
    _id: oid,
    role: { $in: ['creator', 'admin'] },
    isActive: true,
    isBanned: false
  });
  console.log('User (with filters):', user ? JSON.stringify({ name: user.firstName, role: user.role, isActive: user.isActive, isBanned: user.isBanned }) : 'NOT FOUND');

  // Step 3: Check User without filters
  const userRaw = await db.collection('users').findOne({ _id: oid });
  console.log('User (raw):', userRaw ? JSON.stringify({ name: userRaw.firstName, role: userRaw.role, isActive: userRaw.isActive, isBanned: userRaw.isBanned }) : 'NOT FOUND');

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
