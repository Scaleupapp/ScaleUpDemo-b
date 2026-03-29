require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  // Find all users with role=creator who don't have a CreatorProfile
  const creators = await db.collection('users').find({ role: 'creator' }).toArray();
  console.log(`Found ${creators.length} users with role=creator`);

  const profiles = await db.collection('creatorprofiles').find({}).toArray();
  console.log(`Found ${profiles.length} creator profiles`);

  const profileUserIds = new Set(profiles.map(p => p.userId.toString()));

  for (const creator of creators) {
    const uid = creator._id.toString();
    if (!profileUserIds.has(uid)) {
      console.log(`MISSING profile for: ${creator.firstName} ${creator.lastName} (${uid})`);

      // Check if they have an approved application
      const app = await db.collection('creatorapplications').findOne({
        userId: creator._id,
        status: 'approved'
      });

      const domain = app?.domain || 'general';
      const specializations = app?.specializations || creator.skills || [];

      // Also check if they were a seeded creator (no application)
      const tier = app ? 'rising' : 'anchor'; // seeded creators are likely anchor

      const profile = {
        userId: creator._id,
        tier,
        domain,
        specializations,
        isVerified: true,
        verifiedAt: new Date(),
        stats: {
          totalContent: 0,
          totalViews: 0,
          totalFollowers: creator.followersCount || 0,
          averageRating: 0,
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await db.collection('creatorprofiles').insertOne(profile);
      console.log(`  -> Created profile: tier=${tier}, domain=${domain}`);
    } else {
      console.log(`OK: ${creator.firstName} ${creator.lastName} (${uid})`);
    }
  }

  await mongoose.disconnect();
  console.log('Done!');
}

main().catch(e => { console.error(e); process.exit(1); });
