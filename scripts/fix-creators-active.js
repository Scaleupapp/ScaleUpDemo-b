require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  // Find all creators that are inactive
  const result = await db.collection('users').updateMany(
    { role: 'creator', isActive: false },
    { $set: { isActive: true } }
  );
  console.log(`Activated ${result.modifiedCount} inactive creator(s)`);

  // Verify
  const creators = await db.collection('users').find({ role: 'creator' }).toArray();
  creators.forEach(c => console.log(`${c.firstName} ${c.lastName}: isActive=${c.isActive}`));

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
