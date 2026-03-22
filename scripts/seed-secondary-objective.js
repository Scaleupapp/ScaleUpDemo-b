/**
 * Seed a secondary objective for the admin user to test multi-objective switching.
 *
 * Usage: node scripts/seed-secondary-objective.js
 *
 * Creates an "Interview Preparation" objective as a secondary (non-primary) objective
 * for admin@scaleup.io, with a paused journey containing weekly plans and content assignments.
 */

const mongoose = require('mongoose');
require('dotenv').config();

const ADMIN_ID = '699d8aeca7eb4b450fbd22e0';

// Content IDs from the database (reuse existing content for interview-relevant topics)
const CONTENT = {
  pm_strategy: ['699d8b2c37d7eb532eb5d591', '699d8b2e37d7eb532eb5d594'],
  roadmapping: ['699d8b3037d7eb532eb5d597', '699d8b3137d7eb532eb5d59a'],
  user_research: ['699d8b3437d7eb532eb5d59d', '699d8b3637d7eb532eb5d5a0'],
  prioritization: ['699d8b3837d7eb532eb5d5a3', '699d8b3937d7eb532eb5d5a6'],
  pmf: ['699d8b3c37d7eb532eb5d5a9', '699d8b3d37d7eb532eb5d5ac'],
  metrics: ['699d8b4037d7eb532eb5d5af', '699d8b4137d7eb532eb5d5b2'],
  startup: ['699d8b4337d7eb532eb5d5b5', '699d8b4437d7eb532eb5d5b8'],
  leadership: ['699d8b4e37d7eb532eb5d5c7', '699d8b4f37d7eb532eb5d5ca'],
};

function oid(id) {
  return new mongoose.Types.ObjectId(id);
}

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  const UserObjective = require('../src/models/UserObjective');
  const Journey = require('../src/models/Journey');

  const userId = oid(ADMIN_ID);

  // Check if secondary objective already exists
  const existing = await UserObjective.findOne({
    userId,
    objectiveType: 'interview_preparation'
  });

  if (existing) {
    console.log('Secondary objective already exists:', existing._id);
    console.log('Cleaning up to re-seed...');
    await Journey.deleteMany({ userId, objectiveId: existing._id });
    await UserObjective.deleteOne({ _id: existing._id });
    console.log('Cleaned up old data');
  }

  // 1. Create the secondary objective
  const objectiveId = new mongoose.Types.ObjectId();
  const targetDate = daysFromNow(90); // 3 months from now

  const objective = await UserObjective.create({
    _id: objectiveId,
    userId,
    objectiveType: 'interview_preparation',
    specifics: {
      targetRole: 'Senior Product Manager',
      targetCompany: 'Google',
    },
    timeline: '3_months',
    targetDate,
    currentLevel: 'intermediate',
    weeklyCommitHours: 8,
    preferredLearningStyle: 'mix',
    topicsOfInterest: [
      'system design',
      'behavioral questions',
      'product strategy',
      'case studies',
      'metrics & analytics',
      'leadership'
    ],
    status: 'active',
    isPrimary: false,
    weight: 30,
    analysis: {
      competencies: [
        {
          name: 'Product Strategy',
          description: 'Ability to define and articulate product vision, strategy, and roadmap',
          weight: 9,
          category: 'core',
          prerequisites: [],
          assessmentTypes: ['applied_scenario', 'case_study'],
          proficiencyLevels: [
            { level: 1, title: 'Novice', description: 'Basic understanding of product strategy' },
            { level: 2, title: 'Competent', description: 'Can create strategy for small products' },
            { level: 3, title: 'Proficient', description: 'Leads strategy for complex products' },
          ]
        },
        {
          name: 'Analytical Thinking',
          description: 'Data-driven decision making with metrics and KPIs',
          weight: 8,
          category: 'core',
          prerequisites: [],
          assessmentTypes: ['knowledge_recall', 'applied_scenario'],
          proficiencyLevels: [
            { level: 1, title: 'Novice', description: 'Can identify basic metrics' },
            { level: 2, title: 'Competent', description: 'Can set up metrics frameworks' },
            { level: 3, title: 'Proficient', description: 'Expert at deriving insights from data' },
          ]
        },
        {
          name: 'Stakeholder Communication',
          description: 'Effective communication with cross-functional teams and leadership',
          weight: 7,
          category: 'soft_skill',
          prerequisites: [],
          assessmentTypes: ['situational_judgment'],
          proficiencyLevels: [
            { level: 1, title: 'Novice', description: 'Can present ideas clearly' },
            { level: 2, title: 'Competent', description: 'Manages stakeholder expectations' },
            { level: 3, title: 'Proficient', description: 'Influences without authority at exec level' },
          ]
        },
        {
          name: 'User Research',
          description: 'Understanding user needs through research methods',
          weight: 7,
          category: 'core',
          prerequisites: [],
          assessmentTypes: ['applied_scenario', 'framework_application'],
          proficiencyLevels: [
            { level: 1, title: 'Novice', description: 'Can conduct basic interviews' },
            { level: 2, title: 'Competent', description: 'Designs research plans' },
            { level: 3, title: 'Proficient', description: 'Synthesizes complex research into insights' },
          ]
        },
        {
          name: 'Case Study Problem Solving',
          description: 'Structured approach to product case studies in interviews',
          weight: 9,
          category: 'core',
          prerequisites: ['Product Strategy', 'Analytical Thinking'],
          assessmentTypes: ['case_study'],
          proficiencyLevels: [
            { level: 1, title: 'Novice', description: 'Can follow a framework' },
            { level: 2, title: 'Competent', description: 'Applies frameworks to new problems' },
            { level: 3, title: 'Proficient', description: 'Creates novel frameworks for unique cases' },
          ]
        },
      ],
      objectiveBrief: {
        overview: 'Prepare for Senior PM interviews at top tech companies, focusing on product strategy, analytical thinking, and case study problem-solving.',
        dayToDay: 'Study product frameworks, practice case studies, review behavioral question techniques, and analyze product metrics scenarios.',
        challenges: 'Balancing depth vs breadth of PM knowledge, managing interview anxiety, and translating experience into structured interview answers.',
        successCriteria: 'Able to confidently handle product sense, analytical, and behavioral interview rounds.',
        industryContext: 'Senior PM roles at Google require strong product intuition, data-driven decision making, and the ability to influence cross-functional teams.',
      },
      analyzedAt: new Date(),
      aiModel: 'claude-sonnet-4-20250514',
    }
  });

  console.log('Created secondary objective:', objective._id);
  console.log('  Type: interview_preparation');
  console.log('  Role: Senior Product Manager @ Google');
  console.log('  isPrimary: false, weight: 30');

  // 2. Create a paused journey for this objective (so switching has something to resume)
  const journeyCreatedAt = daysAgo(5); // Created 5 days ago

  // Use insertOne to bypass Mongoose validation (scheduledQuiz.type conflicts with Mongoose's type keyword)
  const journeyId = new mongoose.Types.ObjectId();
  await mongoose.connection.collection('journeys').insertOne({
    _id: journeyId,
    userId,
    objectiveId,
    title: 'Senior PM Interview Prep — Google',
    status: 'paused', // Paused because the primary objective (upskilling) is active
    pausedAt: daysAgo(3), // Paused 3 days ago
    pausedDuration: 0, // First time paused, no accumulated pause time yet
    lastResumedAt: null,
    aiModel: 'gpt-4o',
    generatedAt: journeyCreatedAt,
    createdAt: journeyCreatedAt,
    phases: [
      {
        name: 'Foundation — PM Frameworks & Basics',
        type: 'foundation',
        order: 0,
        durationDays: 21,
        startDate: journeyCreatedAt,
        endDate: daysFromNow(16),
        status: 'active',
        objectives: ['Build strong PM framework knowledge', 'Understand key metrics and KPIs'],
        focusTopics: ['product strategy', 'metrics & analytics', 'roadmapping'],
      },
      {
        name: 'Building — Case Studies & Behavioral',
        type: 'building',
        order: 1,
        durationDays: 28,
        startDate: daysFromNow(16),
        endDate: daysFromNow(44),
        status: 'upcoming',
        objectives: ['Master case study frameworks', 'Practice behavioral answers'],
        focusTopics: ['case studies', 'behavioral questions', 'leadership'],
      },
      {
        name: 'Mastery — Mock Interviews & Refinement',
        type: 'mastery',
        order: 2,
        durationDays: 21,
        startDate: daysFromNow(44),
        endDate: daysFromNow(65),
        status: 'upcoming',
        objectives: ['Full mock interview rounds', 'Refine weak areas'],
        focusTopics: ['system design', 'product strategy', 'case studies'],
      },
    ],
    currentPhaseIndex: 0,
    currentWeek: 1,
    weeklyPlans: [
      {
        weekNumber: 1,
        startDate: journeyCreatedAt,
        endDate: daysAgo(0),
        phaseIndex: 0,
        status: 'active',
        dailyAssignments: [
          { day: 1, contentIds: [oid(CONTENT.pm_strategy[0])], topics: ['product strategy'], estimatedTime: 15, completed: true, completedAt: daysAgo(4) },
          { day: 2, contentIds: [oid(CONTENT.pm_strategy[1])], topics: ['product strategy'], estimatedTime: 12, completed: true, completedAt: daysAgo(3) },
          { day: 3, contentIds: [oid(CONTENT.metrics[0])], topics: ['metrics & analytics'], estimatedTime: 10, completed: false },
          { day: 4, contentIds: [oid(CONTENT.metrics[1])], topics: ['metrics & analytics'], estimatedTime: 14, completed: false },
          { day: 5, contentIds: [oid(CONTENT.roadmapping[0])], topics: ['roadmapping'], estimatedTime: 18, completed: false },
          { day: 6, contentIds: [], topics: [], estimatedTime: 0, completed: false }, // Rest day
          { day: 7, contentIds: [], topics: [], estimatedTime: 0, completed: false }, // Rest day
        ],
        scheduledQuiz: { dayOfWeek: 5, type: 'weekly_review', topics: ['product strategy', 'metrics & analytics'], completed: false },
        goals: ['Understand PM frameworks', 'Learn key metrics and KPIs'],
        outcomes: [],
      },
      {
        weekNumber: 2,
        startDate: daysFromNow(1),
        endDate: daysFromNow(7),
        phaseIndex: 0,
        status: 'upcoming',
        dailyAssignments: [
          { day: 1, contentIds: [oid(CONTENT.roadmapping[1])], topics: ['roadmapping'], estimatedTime: 15, completed: false },
          { day: 2, contentIds: [oid(CONTENT.user_research[0])], topics: ['user research'], estimatedTime: 20, completed: false },
          { day: 3, contentIds: [oid(CONTENT.user_research[1])], topics: ['user research'], estimatedTime: 12, completed: false },
          { day: 4, contentIds: [oid(CONTENT.prioritization[0])], topics: ['prioritization'], estimatedTime: 14, completed: false },
          { day: 5, contentIds: [oid(CONTENT.prioritization[1])], topics: ['prioritization'], estimatedTime: 10, completed: false },
          { day: 6, contentIds: [], topics: [], estimatedTime: 0, completed: false },
          { day: 7, contentIds: [], topics: [], estimatedTime: 0, completed: false },
        ],
        scheduledQuiz: { dayOfWeek: 5, type: 'weekly_review', topics: ['roadmapping', 'user research', 'prioritization'], completed: false },
        goals: ['Deep dive into user research methods', 'Learn prioritization frameworks'],
        outcomes: [],
      },
      {
        weekNumber: 3,
        startDate: daysFromNow(8),
        endDate: daysFromNow(14),
        phaseIndex: 0,
        status: 'upcoming',
        dailyAssignments: [
          { day: 1, contentIds: [oid(CONTENT.pmf[0])], topics: ['product-market fit'], estimatedTime: 16, completed: false },
          { day: 2, contentIds: [oid(CONTENT.pmf[1])], topics: ['product-market fit'], estimatedTime: 12, completed: false },
          { day: 3, contentIds: [oid(CONTENT.leadership[0])], topics: ['leadership'], estimatedTime: 18, completed: false },
          { day: 4, contentIds: [oid(CONTENT.leadership[1])], topics: ['leadership'], estimatedTime: 14, completed: false },
          { day: 5, contentIds: [oid(CONTENT.startup[0])], topics: ['startup strategy'], estimatedTime: 15, completed: false },
          { day: 6, contentIds: [], topics: [], estimatedTime: 0, completed: false },
          { day: 7, contentIds: [], topics: [], estimatedTime: 0, completed: false },
        ],
        scheduledQuiz: { dayOfWeek: 5, type: 'weekly_review', topics: ['product-market fit', 'leadership'], completed: false },
        goals: ['Understand PMF frameworks', 'Develop leadership communication skills'],
        outcomes: [],
      },
    ],
    milestones: [
      {
        title: 'Foundation Complete',
        type: 'phase_completion',
        targetCriteria: {},
        scheduledDate: daysFromNow(16),
        status: 'upcoming',
      },
      {
        title: 'PM Metrics Mastery',
        type: 'score_target',
        targetCriteria: { targetScore: 75, targetTopic: 'metrics & analytics' },
        scheduledDate: daysFromNow(10),
        status: 'upcoming',
      },
      {
        title: '7-Day Streak',
        type: 'streak',
        targetCriteria: { streakDays: 7 },
        status: 'upcoming',
      },
    ],
    progress: {
      overallPercentage: 13, // 2 of ~15 items done
      contentConsumed: 2,
      contentAssigned: 15,
      quizzesCompleted: 0,
      quizzesAssigned: 3,
      milestonesCompleted: 0,
      milestonesTotal: 3,
      currentStreak: 0, // Paused, so streak reset
      longestStreak: 2,
    },
    adaptationHistory: [],
    updatedAt: new Date(),
  });

  console.log('Created paused journey:', journeyId);
  console.log('  Title: Senior PM Interview Prep — Google');
  console.log('  Status: paused (will resume when user switches to this objective)');
  console.log('  Progress: 13% (2/15 content items done)');
  console.log('  Phases: 3 (Foundation → Building → Mastery)');
  console.log('  Weeks: 3 planned');

  // 3. Rebalance weights on the primary objective
  const primaryObjective = await UserObjective.findOne({ userId, isPrimary: true, status: 'active' });
  if (primaryObjective) {
    primaryObjective.weight = 70;
    await primaryObjective.save();
    console.log('\nRebalanced primary objective weight to 70');
    console.log('  Primary:', primaryObjective.objectiveType, '(weight: 70)');
    console.log('  Secondary: interview_preparation (weight: 30)');
  }

  console.log('\n✅ Seed complete! The admin user now has 2 objectives:');
  console.log('  1. Primary: Upskilling (existing, weight 70)');
  console.log('  2. Secondary: Interview Prep — Senior PM @ Google (weight 30, paused journey)');
  console.log('\nTo test: Open the app → My Plan/Home/Progress → tap the objective switcher pill');

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
