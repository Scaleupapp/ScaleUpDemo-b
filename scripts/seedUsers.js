#!/usr/bin/env node

/**
 * Seed Script: Create admin, consumers, and creators (rising/core/anchor)
 * Usage: node scripts/seedUsers.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const User = require('../src/models/User');
const CreatorProfile = require('../src/models/CreatorProfile');

const USERS = [
  // ─── Admin ──────────────────────────────────────────────────────
  {
    email: 'admin@scaleup.io',
    password: 'Admin@123456',
    firstName: 'ScaleUp',
    lastName: 'Admin',
    role: 'admin',
    authProvider: 'local',
    isEmailVerified: true,
    onboardingComplete: true,
    onboardingStep: 4,
  },

  // ─── Consumers ──────────────────────────────────────────────────
  {
    email: 'rahul@test.com',
    password: 'Test@12345',
    firstName: 'Rahul',
    lastName: 'Sharma',
    role: 'consumer',
    authProvider: 'local',
    isEmailVerified: true,
    onboardingComplete: true,
    onboardingStep: 4,
  },
  {
    email: 'priya@test.com',
    password: 'Test@12345',
    firstName: 'Priya',
    lastName: 'Patel',
    role: 'consumer',
    authProvider: 'local',
    isEmailVerified: true,
    onboardingComplete: true,
    onboardingStep: 4,
  },
  {
    email: 'arjun@test.com',
    password: 'Test@12345',
    firstName: 'Arjun',
    lastName: 'Mehta',
    role: 'consumer',
    authProvider: 'local',
    isEmailVerified: true,
    onboardingComplete: true,
    onboardingStep: 4,
  },

  // ─── Creators ───────────────────────────────────────────────────
  // Anchor
  {
    email: 'anchor.pm@scaleup.io',
    password: 'Creator@123',
    firstName: 'Deepa',
    lastName: 'Krishnan',
    role: 'creator',
    authProvider: 'local',
    isEmailVerified: true,
    onboardingComplete: true,
    onboardingStep: 4,
    _creatorProfile: {
      tier: 'anchor',
      domain: 'product management',
      specializations: ['product strategy', 'roadmapping', 'user research'],
      bio: 'VP of Product at a Fortune 500. 15+ years in PM.',
      isVerified: true,
      stats: { totalContent: 65, totalViews: 45000, totalFollowers: 2200, averageRating: 4.8 },
    },
  },
  {
    email: 'anchor.mba@scaleup.io',
    password: 'Creator@123',
    firstName: 'Vikram',
    lastName: 'Iyer',
    role: 'creator',
    authProvider: 'local',
    isEmailVerified: true,
    onboardingComplete: true,
    onboardingStep: 4,
    _creatorProfile: {
      tier: 'anchor',
      domain: 'mba preparation',
      specializations: ['case study', 'finance basics', 'strategy'],
      bio: 'ISB professor & GMAT 780. Coached 500+ MBA aspirants.',
      isVerified: true,
      stats: { totalContent: 52, totalViews: 38000, totalFollowers: 1800, averageRating: 4.7 },
    },
  },

  // Core
  {
    email: 'core.entrepreneur@scaleup.io',
    password: 'Creator@123',
    firstName: 'Ananya',
    lastName: 'Reddy',
    role: 'creator',
    authProvider: 'local',
    isEmailVerified: true,
    onboardingComplete: true,
    onboardingStep: 4,
    _creatorProfile: {
      tier: 'core',
      domain: 'entrepreneurship',
      specializations: ['startup', 'fundraising', 'business model'],
      bio: '2x founder. Raised $5M Series A. YC alum.',
      isVerified: true,
      stats: { totalContent: 28, totalViews: 15000, totalFollowers: 600, averageRating: 4.3 },
    },
  },
  {
    email: 'core.marketing@scaleup.io',
    password: 'Creator@123',
    firstName: 'Karan',
    lastName: 'Singh',
    role: 'creator',
    authProvider: 'local',
    isEmailVerified: true,
    onboardingComplete: true,
    onboardingStep: 4,
    _creatorProfile: {
      tier: 'core',
      domain: 'marketing',
      specializations: ['digital marketing', 'branding', 'growth hacking'],
      bio: 'Head of Growth at a D2C unicorn. Ex-Google.',
      isVerified: true,
      stats: { totalContent: 22, totalViews: 12000, totalFollowers: 450, averageRating: 4.1 },
    },
  },

  // Rising
  {
    email: 'rising.sat@scaleup.io',
    password: 'Creator@123',
    firstName: 'Neha',
    lastName: 'Gupta',
    role: 'creator',
    authProvider: 'local',
    isEmailVerified: true,
    onboardingComplete: true,
    onboardingStep: 4,
    _creatorProfile: {
      tier: 'rising',
      domain: 'sat preparation',
      specializations: ['sat math', 'test strategy'],
      bio: 'SAT 1580. Tutored 100+ students to 1500+.',
      isVerified: true,
      stats: { totalContent: 8, totalViews: 3000, totalFollowers: 120, averageRating: 4.4 },
    },
  },
  {
    email: 'rising.softskills@scaleup.io',
    password: 'Creator@123',
    firstName: 'Rohan',
    lastName: 'Desai',
    role: 'creator',
    authProvider: 'local',
    isEmailVerified: true,
    onboardingComplete: true,
    onboardingStep: 4,
    _creatorProfile: {
      tier: 'rising',
      domain: 'business soft skills',
      specializations: ['communication', 'public speaking', 'negotiation'],
      bio: 'Corporate trainer. TEDx speaker. 10 years in L&D.',
      isVerified: true,
      stats: { totalContent: 5, totalViews: 1500, totalFollowers: 80, averageRating: 4.2 },
    },
  },
];

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('ERROR: MONGODB_URI not set');
    process.exit(1);
  }

  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected.\n');

  console.log('='.repeat(55));
  console.log('  ScaleUp User Seed');
  console.log('='.repeat(55));

  for (const userData of USERS) {
    const profile = userData._creatorProfile;
    delete userData._creatorProfile;

    const existing = await User.findOne({ email: userData.email });
    if (existing) {
      console.log(`  SKIP  ${userData.email} (already exists)`);
      continue;
    }

    const user = await User.create(userData);

    if (profile) {
      profile.userId = user._id;
      profile.verifiedAt = new Date();
      await CreatorProfile.create(profile);
    }

    const tag = userData.role === 'admin' ? 'ADMIN'
      : userData.role === 'creator' ? profile.tier.toUpperCase()
      : 'USER';
    console.log(`  [${tag}]  ${userData.firstName} ${userData.lastName} — ${userData.email}`);
  }

  console.log('\n' + '='.repeat(55));
  console.log('  CREDENTIALS');
  console.log('='.repeat(55));
  console.log('  Admin:      admin@scaleup.io / Admin@123456');
  console.log('  Consumers:  rahul@test.com / Test@12345');
  console.log('              priya@test.com / Test@12345');
  console.log('              arjun@test.com / Test@12345');
  console.log('  Anchor:     anchor.pm@scaleup.io / Creator@123');
  console.log('              anchor.mba@scaleup.io / Creator@123');
  console.log('  Core:       core.entrepreneur@scaleup.io / Creator@123');
  console.log('              core.marketing@scaleup.io / Creator@123');
  console.log('  Rising:     rising.sat@scaleup.io / Creator@123');
  console.log('              rising.softskills@scaleup.io / Creator@123');
  console.log('='.repeat(55));

  await mongoose.disconnect();
  console.log('\nDone.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  mongoose.disconnect().finally(() => process.exit(1));
});
