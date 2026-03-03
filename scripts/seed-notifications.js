/**
 * Seed realistic in-app notifications for the admin user.
 * Run: node scripts/seed-notifications.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const ADMIN_USER_ID = '699d8aeca7eb4b450fbd22e0';

function hoursAgo(h) { return new Date(Date.now() - h * 60 * 60 * 1000); }
function daysAgo(d) { return new Date(Date.now() - d * 24 * 60 * 60 * 1000); }

const notifications = [
  {
    userId: ADMIN_USER_ID,
    type: 'quiz_available',
    title: 'New Quiz Available',
    message: 'Test your knowledge on "Product Strategy Frameworks" — 10 questions ready.',
    isRead: false,
    deepLink: '/quizzes',
    createdAt: hoursAgo(0.25),
    updatedAt: hoursAgo(0.25),
  },
  {
    userId: ADMIN_USER_ID,
    type: 'milestone_reached',
    title: '3-Day Streak!',
    message: "You've been learning for 3 days straight. Keep the momentum going!",
    isRead: false,
    deepLink: '/home',
    createdAt: hoursAgo(1),
    updatedAt: hoursAgo(1),
  },
  {
    userId: ADMIN_USER_ID,
    type: 'journey_update',
    title: 'Journey Adapted',
    message: 'Your learning journey has been adapted based on your recent quiz performance.',
    isRead: false,
    deepLink: '/journey',
    createdAt: hoursAgo(4),
    updatedAt: hoursAgo(4),
  },
  {
    userId: ADMIN_USER_ID,
    type: 'quiz_available',
    title: 'Weekly Review Quiz',
    message: 'Your weekly review quiz covering Stakeholder Management and User Research is ready.',
    isRead: false,
    deepLink: '/quizzes',
    createdAt: hoursAgo(8),
    updatedAt: hoursAgo(8),
  },
  {
    userId: ADMIN_USER_ID,
    type: 'milestone_reached',
    title: 'Phase 1 Complete!',
    message: "Congratulations! You've completed the Foundation phase of your PM journey.",
    isRead: true,
    deepLink: '/journey',
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
  },
  {
    userId: ADMIN_USER_ID,
    type: 'quiz_available',
    title: 'Knowledge Check',
    message: "It's been a while since you reviewed Agile & Scrum. Take a quick retention check!",
    isRead: true,
    deepLink: '/quizzes',
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
  },
  {
    userId: ADMIN_USER_ID,
    type: 'streak_reminder',
    title: "Don't Lose Your Streak",
    message: "You haven't completed any content today. A 5-minute session is all it takes.",
    isRead: true,
    deepLink: '/journey/today',
    createdAt: daysAgo(2),
    updatedAt: daysAgo(2),
  },
  {
    userId: ADMIN_USER_ID,
    type: 'journey_update',
    title: 'Week 2 Started',
    message: 'Your Week 2 plan is ready with 5 new assignments covering User Research Methods.',
    isRead: true,
    deepLink: '/journey',
    createdAt: daysAgo(2),
    updatedAt: daysAgo(2),
  },
  {
    userId: ADMIN_USER_ID,
    type: 'milestone_reached',
    title: 'First Quiz Aced!',
    message: 'You scored 80% on your first quiz. Great start to your PM journey!',
    isRead: true,
    deepLink: '/quizzes',
    createdAt: daysAgo(3),
    updatedAt: daysAgo(3),
  },
  {
    userId: ADMIN_USER_ID,
    type: 'journey_update',
    title: 'Journey Created',
    message: 'Your personalized learning journey "Senior PM Transition" is ready. Let\'s get started!',
    isRead: true,
    deepLink: '/journey',
    createdAt: daysAgo(5),
    updatedAt: daysAgo(5),
  },
];

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  const db = mongoose.connection.db;
  const col = db.collection('notifications');

  // Clear existing notifications for admin
  const deleted = await col.deleteMany({ userId: new mongoose.Types.ObjectId(ADMIN_USER_ID) });
  console.log(`Cleared ${deleted.deletedCount} old notifications`);

  // Insert with ObjectId conversion
  const docs = notifications.map(n => ({
    ...n,
    userId: new mongoose.Types.ObjectId(n.userId),
    _id: new mongoose.Types.ObjectId(),
  }));

  await col.insertMany(docs);
  console.log(`Inserted ${docs.length} notifications`);

  // Verify
  const count = await col.countDocuments({ userId: new mongoose.Types.ObjectId(ADMIN_USER_ID) });
  const unread = await col.countDocuments({ userId: new mongoose.Types.ObjectId(ADMIN_USER_ID), isRead: false });
  console.log(`Total: ${count}, Unread: ${unread}`);

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
