const mongoose = require('mongoose');
require('dotenv').config();

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  // Find admin user
  const users = await db.collection('users').find({}).toArray();
  console.log('=== USERS ===');
  users.forEach(u => console.log(JSON.stringify({ _id: u._id, name: u.name, email: u.email, role: u.role })));

  const adminUser = users.find(u => u.role === 'admin') || users[0];
  if (!adminUser) { console.log('No users found'); process.exit(1); }
  const userId = adminUser._id.toString();
  console.log('\nAdmin userId:', userId);

  // Content
  const content = await db.collection('contents').find({}).toArray();
  console.log('\n=== CONTENT (' + content.length + ' items) ===');
  content.forEach(c => console.log(JSON.stringify({
    _id: c._id, title: c.title, contentType: c.contentType,
    topics: c.topics, domain: c.domain, difficulty: c.difficulty,
    duration: c.duration, sourceType: c.sourceType
  })));

  // Objectives
  const objectives = await db.collection('objectives').find({ userId }).toArray();
  console.log('\n=== OBJECTIVES (' + objectives.length + ') ===');
  objectives.forEach(o => console.log(JSON.stringify(o)));

  // Journey
  const journeys = await db.collection('journeys').find({ userId }).toArray();
  console.log('\n=== JOURNEYS (' + journeys.length + ') ===');
  journeys.forEach(j => console.log(JSON.stringify({
    _id: j._id, objectiveId: j.objectiveId, status: j.status,
    totalWeeks: j.totalWeeks, currentWeek: j.currentWeek,
    weeklyPlans: j.weeklyPlans ? j.weeklyPlans.length + ' weeks' : 'none',
    milestones: j.milestones ? j.milestones.length + ' milestones' : 'none'
  })));

  // Full journey details for first journey
  if (journeys.length > 0) {
    console.log('\n=== FIRST JOURNEY FULL ===');
    console.log(JSON.stringify(journeys[0], null, 2));
  }

  // Knowledge Profile
  const kp = await db.collection('knowledgeprofiles').find({ userId }).toArray();
  console.log('\n=== KNOWLEDGE PROFILES (' + kp.length + ') ===');
  kp.forEach(k => console.log(JSON.stringify(k)));

  // Consumption Graph
  const cg = await db.collection('consumptiongraphs').find({ userId }).toArray();
  console.log('\n=== CONSUMPTION GRAPHS (' + cg.length + ') ===');
  cg.forEach(c => console.log(JSON.stringify(c)));

  // Content Progress
  const cp = await db.collection('contentprogresses').find({ userId }).toArray();
  console.log('\n=== CONTENT PROGRESS (' + cp.length + ') ===');
  cp.forEach(p => console.log(JSON.stringify({
    _id: p._id, contentId: p.contentId, status: p.status,
    progressPercent: p.progressPercent, completedAt: p.completedAt
  })));

  // Quizzes
  const quizzes = await db.collection('quizzes').find({ userId }).toArray();
  console.log('\n=== QUIZZES (' + quizzes.length + ') ===');
  quizzes.forEach(q => console.log(JSON.stringify({
    _id: q._id, title: q.title, topic: q.topic, type: q.type,
    status: q.status, totalQuestions: q.totalQuestions,
    questionCount: q.questions ? q.questions.length : 0
  })));

  // Quiz Attempts
  const qa = await db.collection('quizattempts').find({ userId }).toArray();
  console.log('\n=== QUIZ ATTEMPTS (' + qa.length + ') ===');
  qa.forEach(a => console.log(JSON.stringify({
    _id: a._id, quizId: a.quizId, status: a.status,
    score: a.score, startedAt: a.startedAt, completedAt: a.completedAt
  })));

  // Quiz Triggers
  const qt = await db.collection('quiztriggers').find({ userId }).toArray();
  console.log('\n=== QUIZ TRIGGERS (' + qt.length + ') ===');
  qt.forEach(t => console.log(JSON.stringify(t)));

  // Today plan
  const tp = await db.collection('todayplans').find({ userId }).toArray();
  console.log('\n=== TODAY PLANS (' + tp.length + ') ===');
  tp.forEach(t => console.log(JSON.stringify(t)));

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
