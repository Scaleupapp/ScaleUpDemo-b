#!/usr/bin/env node

/**
 * Assigns all content with creatorId=null to the admin user.
 * Usage: node scripts/assignContentToAdmin.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const User = require('../src/models/User');
const Content = require('../src/models/Content');

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('ERROR: MONGODB_URI not set');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB.\n');

  const admin = await User.findOne({ email: 'admin@scaleup.io' });
  if (!admin) {
    console.error('Admin user not found. Run seedUsers.js first.');
    process.exit(1);
  }

  console.log(`Admin user: ${admin.firstName} ${admin.lastName} (${admin._id})\n`);

  const result = await Content.updateMany(
    { creatorId: null },
    { $set: { creatorId: admin._id } }
  );

  console.log(`Updated ${result.modifiedCount} content items → creatorId set to admin`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  mongoose.disconnect().finally(() => process.exit(1));
});
