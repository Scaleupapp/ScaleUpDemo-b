const mongoose = require('mongoose');
require('dotenv').config();

const ADMIN_ID = '699d8aeca7eb4b450fbd22e0';

// Content IDs organized by topic (from the database dump)
const CONTENT = {
  // Product Management
  pm_strategy: [
    '699d8b2c37d7eb532eb5d591', // What do product managers do?
    '699d8b2e37d7eb532eb5d594', // 15 PM Terms
  ],
  roadmapping: [
    '699d8b3037d7eb532eb5d597', // Build Product Roadmap
    '699d8b3137d7eb532eb5d59a', // BUILD Roadmaps Guide
  ],
  user_research: [
    '699d8b3437d7eb532eb5d59d', // Doing User Research
    '699d8b3637d7eb532eb5d5a0', // UX Research
  ],
  prioritization: [
    '699d8b3837d7eb532eb5d5a3', // Prioritization Frameworks
    '699d8b3937d7eb532eb5d5a6', // Top 4 Prioritization
  ],
  pmf: [
    '699d8b3c37d7eb532eb5d5a9', // Product-Market Fit fast
    '699d8b3d37d7eb532eb5d5ac', // PMF Framework
  ],
  metrics: [
    '699d8b4037d7eb532eb5d5af', // Top 5 KPIs
    '699d8b4137d7eb532eb5d5b2', // 3 KPIs
  ],
  // Entrepreneurship
  startup: [
    '699d8b4337d7eb532eb5d5b5', // 7 Ways to Start Up
    '699d8b4437d7eb532eb5d5b8', // Build Startup 2026
  ],
  fundraising: [
    '699d8b4737d7eb532eb5d5bb', // Secret to Pitching
    '699d8b4837d7eb532eb5d5be', // How to Raise Startup Funding
  ],
  business_model: [
    '699d8b4a37d7eb532eb5d5c1', // Business Model Canvas Intro
    '699d8b4c37d7eb532eb5d5c4', // BMC Explained
  ],
  leadership: [
    '699d8b4e37d7eb532eb5d5c7', // Strong Startup CEO
    '699d8b4f37d7eb532eb5d5ca', // Self-leadership
  ],
  lean_startup: [
    '699d8b5137d7eb532eb5d5cd', // Lean Startup Summary
    '699d8b5237d7eb532eb5d5d0', // 5 Principles Lean
  ],
  // Marketing
  digital_marketing: [
    '699d8b8137d7eb532eb5d61d', // Digital Marketing 101
    '699d8b8237d7eb532eb5d620', // Digital Marketing Hindi
  ],
  branding: [
    '699d8b8537d7eb532eb5d623', // 7 Strategies Brand
    '699d8b8637d7eb532eb5d626', // 7 Secrets Branding
  ],
  content_marketing: [
    '699d8b8837d7eb532eb5d629', // Social Media Marketing
    '699d8b8937d7eb532eb5d62c', // Content Marketing Strategies
  ],
  growth_hacking: [
    '699d8b8c37d7eb532eb5d62f', // Growth hacks
    '699d8b8d37d7eb532eb5d632', // Growth Hacking SaaS
  ],
};

function oid(id) {
  return new mongoose.Types.ObjectId(id);
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function hoursAgo(n) {
  const d = new Date();
  d.setHours(d.getHours() - n);
  return d;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  console.log('Connected. Seeding data for admin user...');

  // =====================
  // 1. OBJECTIVE
  // =====================
  const objectiveId = new mongoose.Types.ObjectId();
  await db.collection('userobjectives').deleteMany({ userId: oid(ADMIN_ID) });
  await db.collection('userobjectives').insertOne({
    _id: objectiveId,
    userId: oid(ADMIN_ID),
    objectiveType: 'upskilling',
    specifics: {
      targetRole: 'Senior Product Manager',
      targetSkill: 'Product Management',
    },
    timeline: '3_months',
    targetDate: new Date('2026-05-26'),
    currentLevel: 'intermediate',
    weeklyCommitHours: 10,
    preferredLearningStyle: 'mix',
    topicsOfInterest: [
      'product management', 'product strategy', 'roadmapping',
      'user research', 'prioritization', 'product-market fit',
      'metrics', 'entrepreneurship', 'marketing'
    ],
    status: 'active',
    isPrimary: true,
    weight: 100,
    createdAt: daysAgo(21),
    updatedAt: daysAgo(1),
  });
  console.log('  Objective created:', objectiveId.toString());

  // =====================
  // 2. CONTENT PROGRESS
  // =====================
  await db.collection('contentprogresses').deleteMany({ userId: oid(ADMIN_ID) });

  const progressRecords = [];

  // Completed content (watched fully) — PM Strategy, Roadmapping, User Research, some Entrepreneurship
  const completedContent = [
    ...CONTENT.pm_strategy,
    ...CONTENT.roadmapping,
    ...CONTENT.user_research,
    CONTENT.startup[0],
    CONTENT.business_model[0],
    CONTENT.digital_marketing[0],
  ];

  // Space completions so the last 3 are on consecutive recent days (today, yesterday, 2 days ago)
  // for a realistic streak. Older ones are spread across earlier days.
  const completionDays = [14, 13, 12, 10, 8, 5, 2, 1, 0]; // days ago for each completion
  completedContent.forEach((cid, i) => {
    const dAgo = completionDays[i] !== undefined ? completionDays[i] : 14 - i;
    progressRecords.push({
      userId: oid(ADMIN_ID),
      contentId: oid(cid),
      percentageCompleted: 100,
      currentPosition: 0,
      isCompleted: true,
      completedAt: daysAgo(dAgo),
      totalTimeSpent: 300 + Math.floor(Math.random() * 600),
      sessionCount: Math.ceil(Math.random() * 3),
      lastSessionAt: daysAgo(dAgo),
      firstViewedAt: daysAgo(dAgo + 1),
      liked: Math.random() > 0.4,
      saved: Math.random() > 0.5,
      createdAt: daysAgo(dAgo + 1),
      updatedAt: daysAgo(dAgo),
    });
  });

  // In-progress content — Prioritization, PMF
  const inProgressContent = [
    { id: CONTENT.prioritization[0], pct: 72, pos: 837 },
    { id: CONTENT.pmf[0], pct: 35, pos: 242 },
    { id: CONTENT.metrics[0], pct: 15, pos: 48 },
    { id: CONTENT.fundraising[0], pct: 50, pos: 143 },
  ];

  inProgressContent.forEach((item) => {
    progressRecords.push({
      userId: oid(ADMIN_ID),
      contentId: oid(item.id),
      percentageCompleted: item.pct,
      currentPosition: item.pos,
      isCompleted: false,
      totalTimeSpent: Math.floor(item.pct * 8),
      sessionCount: Math.ceil(Math.random() * 2),
      lastSessionAt: daysAgo(1),
      firstViewedAt: daysAgo(3),
      liked: false,
      saved: true,
      createdAt: daysAgo(3),
      updatedAt: daysAgo(1),
    });
  });

  await db.collection('contentprogresses').insertMany(progressRecords);
  console.log(`  Content progress: ${completedContent.length} completed, ${inProgressContent.length} in-progress`);

  // =====================
  // 3. KNOWLEDGE PROFILE
  // =====================
  await db.collection('knowledgeprofiles').deleteMany({ userId: oid(ADMIN_ID) });
  await db.collection('knowledgeprofiles').insertOne({
    userId: oid(ADMIN_ID),
    topicMastery: [
      {
        topic: 'product management',
        score: 78,
        level: 'intermediate',
        quizzesTaken: 3,
        lastAssessedAt: daysAgo(2),
        scoreHistory: [
          { score: 55, date: daysAgo(18) },
          { score: 68, date: daysAgo(10) },
          { score: 78, date: daysAgo(2) },
        ],
        trend: 'improving',
      },
      {
        topic: 'product strategy',
        score: 82,
        level: 'advanced',
        quizzesTaken: 2,
        lastAssessedAt: daysAgo(3),
        scoreHistory: [
          { score: 70, date: daysAgo(15) },
          { score: 82, date: daysAgo(3) },
        ],
        trend: 'improving',
      },
      {
        topic: 'roadmapping',
        score: 72,
        level: 'intermediate',
        quizzesTaken: 2,
        lastAssessedAt: daysAgo(5),
        scoreHistory: [
          { score: 60, date: daysAgo(14) },
          { score: 72, date: daysAgo(5) },
        ],
        trend: 'improving',
      },
      {
        topic: 'user research',
        score: 65,
        level: 'intermediate',
        quizzesTaken: 1,
        lastAssessedAt: daysAgo(8),
        scoreHistory: [
          { score: 65, date: daysAgo(8) },
        ],
        trend: 'stable',
      },
      {
        topic: 'prioritization',
        score: 45,
        level: 'beginner',
        quizzesTaken: 1,
        lastAssessedAt: daysAgo(6),
        scoreHistory: [
          { score: 45, date: daysAgo(6) },
        ],
        trend: 'stable',
      },
      {
        topic: 'product-market fit',
        score: 30,
        level: 'beginner',
        quizzesTaken: 0,
        lastAssessedAt: null,
        scoreHistory: [],
        trend: 'stable',
      },
      {
        topic: 'metrics',
        score: 20,
        level: 'not_started',
        quizzesTaken: 0,
        lastAssessedAt: null,
        scoreHistory: [],
        trend: 'stable',
      },
      {
        topic: 'entrepreneurship',
        score: 55,
        level: 'intermediate',
        quizzesTaken: 1,
        lastAssessedAt: daysAgo(7),
        scoreHistory: [
          { score: 55, date: daysAgo(7) },
        ],
        trend: 'stable',
      },
      {
        topic: 'marketing',
        score: 35,
        level: 'beginner',
        quizzesTaken: 0,
        lastAssessedAt: null,
        scoreHistory: [],
        trend: 'stable',
      },
    ],
    learningVelocity: {
      topicsPerWeek: 2.5,
      averageScoreImprovement: 12,
      contentToMasteryRatio: 3.2,
    },
    retention: {
      averageRetentionRate: 72,
      optimalReviewInterval: 5,
    },
    behavioralProfile: {
      type: 'balanced',
      averageAnswerTime: 32,
      peakHours: [9, 10, 14, 15, 21],
      consistencyScore: 68,
    },
    strengths: ['product strategy', 'product management', 'roadmapping'],
    weaknesses: ['prioritization', 'metrics', 'product-market fit'],
    overallScore: 58,
    totalQuizzesTaken: 5,
    totalTopicsCovered: 6,
    lastUpdatedAt: daysAgo(1),
    createdAt: daysAgo(21),
    updatedAt: daysAgo(1),
  });
  console.log('  Knowledge profile created');

  // =====================
  // 4. CONSUMPTION GRAPH
  // =====================
  await db.collection('consumptiongraphs').deleteMany({ userId: oid(ADMIN_ID) });
  await db.collection('consumptiongraphs').insertOne({
    userId: oid(ADMIN_ID),
    topicNodes: [
      {
        topic: 'product management',
        contentConsumed: 4,
        totalTimeSpent: 2100,
        lastConsumedAt: daysAgo(2),
        affinityScore: 92,
        contentIds: [...CONTENT.pm_strategy, ...CONTENT.roadmapping].map(oid),
      },
      {
        topic: 'product strategy',
        contentConsumed: 2,
        totalTimeSpent: 1061,
        lastConsumedAt: daysAgo(3),
        affinityScore: 85,
        contentIds: CONTENT.pm_strategy.map(oid),
      },
      {
        topic: 'roadmapping',
        contentConsumed: 2,
        totalTimeSpent: 674,
        lastConsumedAt: daysAgo(5),
        affinityScore: 78,
        contentIds: CONTENT.roadmapping.map(oid),
      },
      {
        topic: 'user research',
        contentConsumed: 2,
        totalTimeSpent: 1516,
        lastConsumedAt: daysAgo(8),
        affinityScore: 70,
        contentIds: CONTENT.user_research.map(oid),
      },
      {
        topic: 'prioritization',
        contentConsumed: 1,
        totalTimeSpent: 600,
        lastConsumedAt: daysAgo(1),
        affinityScore: 60,
        contentIds: [oid(CONTENT.prioritization[0])],
      },
      {
        topic: 'entrepreneurship',
        contentConsumed: 2,
        totalTimeSpent: 942,
        lastConsumedAt: daysAgo(7),
        affinityScore: 55,
        contentIds: [oid(CONTENT.startup[0]), oid(CONTENT.business_model[0])],
      },
      {
        topic: 'marketing',
        contentConsumed: 1,
        totalTimeSpent: 1052,
        lastConsumedAt: daysAgo(4),
        affinityScore: 40,
        contentIds: [oid(CONTENT.digital_marketing[0])],
      },
    ],
    topicEdges: [
      { topicA: 'product management', topicB: 'product strategy', strength: 90 },
      { topicA: 'product management', topicB: 'roadmapping', strength: 85 },
      { topicA: 'product management', topicB: 'user research', strength: 75 },
      { topicA: 'product management', topicB: 'prioritization', strength: 70 },
      { topicA: 'entrepreneurship', topicB: 'marketing', strength: 60 },
      { topicA: 'product management', topicB: 'metrics', strength: 65 },
      { topicA: 'roadmapping', topicB: 'prioritization', strength: 80 },
    ],
    totalContentConsumed: 14,
    totalTimeSpent: 7945,
    dominantTopics: ['product management', 'product strategy', 'roadmapping'],
    lastUpdatedAt: daysAgo(1),
    createdAt: daysAgo(21),
    updatedAt: daysAgo(1),
  });
  console.log('  Consumption graph created');

  // =====================
  // 5. QUIZZES + ATTEMPTS
  // =====================
  await db.collection('quizzes').deleteMany({ userId: oid(ADMIN_ID) });
  await db.collection('quizattempts').deleteMany({ userId: oid(ADMIN_ID) });

  // --- Quiz 1: Product Strategy (completed, scored 80%) ---
  const quiz1Id = new mongoose.Types.ObjectId();
  const quiz1Questions = [
    {
      _id: new mongoose.Types.ObjectId(),
      questionText: 'What is the primary role of a product manager?',
      questionType: 'conceptual',
      options: [
        { _id: new mongoose.Types.ObjectId(), label: 'A', text: 'Writing code for the development team' },
        { _id: new mongoose.Types.ObjectId(), label: 'B', text: 'Defining the product vision and strategy while bridging business, technology, and user needs' },
        { _id: new mongoose.Types.ObjectId(), label: 'C', text: 'Managing the engineering team\'s schedule' },
        { _id: new mongoose.Types.ObjectId(), label: 'D', text: 'Designing the user interface' },
      ],
      correctAnswer: 'B',
      explanation: 'A product manager acts as the intersection of business, technology, and user experience, defining what to build and why.',
      difficulty: 'easy',
      sourceContentId: oid(CONTENT.pm_strategy[0]),
      concept: 'PM role definition',
    },
    {
      _id: new mongoose.Types.ObjectId(),
      questionText: 'Which of these is NOT a typical product management artifact?',
      questionType: 'conceptual',
      options: [
        { _id: new mongoose.Types.ObjectId(), label: 'A', text: 'Product Requirements Document (PRD)' },
        { _id: new mongoose.Types.ObjectId(), label: 'B', text: 'Product Roadmap' },
        { _id: new mongoose.Types.ObjectId(), label: 'C', text: 'Sprint Burndown Chart' },
        { _id: new mongoose.Types.ObjectId(), label: 'D', text: 'User Story Map' },
      ],
      correctAnswer: 'C',
      explanation: 'Sprint burndown charts are typically owned by scrum masters or engineering leads, not product managers.',
      difficulty: 'medium',
      sourceContentId: oid(CONTENT.pm_strategy[1]),
      concept: 'PM artifacts',
    },
    {
      _id: new mongoose.Types.ObjectId(),
      questionText: 'What does "product-led growth" mean?',
      questionType: 'application',
      options: [
        { _id: new mongoose.Types.ObjectId(), label: 'A', text: 'Growth driven primarily by sales teams' },
        { _id: new mongoose.Types.ObjectId(), label: 'B', text: 'Growth driven by the product experience itself as the primary driver of acquisition, retention, and expansion' },
        { _id: new mongoose.Types.ObjectId(), label: 'C', text: 'Growth through aggressive advertising' },
        { _id: new mongoose.Types.ObjectId(), label: 'D', text: 'Growth by hiring more product managers' },
      ],
      correctAnswer: 'B',
      explanation: 'Product-led growth uses the product as the main vehicle for growth — users experience value before or without talking to sales.',
      difficulty: 'medium',
      sourceContentId: oid(CONTENT.pm_strategy[1]),
      concept: 'Product-led growth',
    },
    {
      _id: new mongoose.Types.ObjectId(),
      questionText: 'In the context of product strategy, what is a "North Star Metric"?',
      questionType: 'conceptual',
      options: [
        { _id: new mongoose.Types.ObjectId(), label: 'A', text: 'The company\'s stock price' },
        { _id: new mongoose.Types.ObjectId(), label: 'B', text: 'A single key metric that captures the core value your product delivers to customers' },
        { _id: new mongoose.Types.ObjectId(), label: 'C', text: 'The total number of users' },
        { _id: new mongoose.Types.ObjectId(), label: 'D', text: 'Monthly revenue' },
      ],
      correctAnswer: 'B',
      explanation: 'A North Star Metric is the one metric that best captures the value you deliver. For Airbnb it\'s nights booked, for Facebook it was daily active users.',
      difficulty: 'medium',
      sourceContentId: oid(CONTENT.pm_strategy[0]),
      concept: 'North Star Metric',
    },
    {
      _id: new mongoose.Types.ObjectId(),
      questionText: 'What is the difference between output and outcome in product management?',
      questionType: 'critical_thinking',
      options: [
        { _id: new mongoose.Types.ObjectId(), label: 'A', text: 'They are the same thing' },
        { _id: new mongoose.Types.ObjectId(), label: 'B', text: 'Output is what you build; outcome is the impact it creates for users and business' },
        { _id: new mongoose.Types.ObjectId(), label: 'C', text: 'Output is revenue; outcome is user satisfaction' },
        { _id: new mongoose.Types.ObjectId(), label: 'D', text: 'Output comes before outcome chronologically, but they measure the same thing' },
      ],
      correctAnswer: 'B',
      explanation: 'Outputs are features shipped; outcomes are the changes in user behavior or business results. Great PMs focus on outcomes over outputs.',
      difficulty: 'hard',
      sourceContentId: oid(CONTENT.pm_strategy[0]),
      concept: 'Outcomes vs Outputs',
    },
  ];

  await db.collection('quizzes').insertOne({
    _id: quiz1Id,
    userId: oid(ADMIN_ID),
    title: 'Product Strategy Fundamentals',
    type: 'topic_consolidation',
    topic: 'product strategy',
    sourceContentIds: CONTENT.pm_strategy.map(oid),
    objectiveId: objectiveId,
    questions: quiz1Questions,
    totalQuestions: 5,
    timePerQuestion: 60,
    status: 'completed',
    deliveredAt: daysAgo(3),
    aiModel: 'gpt-4o',
    generatedAt: daysAgo(3),
    createdAt: daysAgo(3),
    updatedAt: daysAgo(3),
  });

  const attempt1Id = new mongoose.Types.ObjectId();
  await db.collection('quizattempts').insertOne({
    _id: attempt1Id,
    userId: oid(ADMIN_ID),
    quizId: quiz1Id,
    answers: [
      { questionIndex: 0, selectedAnswer: 'B', isCorrect: true, timeTaken: 18 },
      { questionIndex: 1, selectedAnswer: 'C', isCorrect: true, timeTaken: 35 },
      { questionIndex: 2, selectedAnswer: 'B', isCorrect: true, timeTaken: 22 },
      { questionIndex: 3, selectedAnswer: 'B', isCorrect: true, timeTaken: 28 },
      { questionIndex: 4, selectedAnswer: 'D', isCorrect: false, timeTaken: 45 },
    ],
    score: {
      total: 5,
      correct: 4,
      incorrect: 1,
      skipped: 0,
      percentage: 80,
    },
    topicBreakdown: [
      { topic: 'product strategy', correct: 4, total: 5, percentage: 80 },
    ],
    analysis: {
      strengths: [
        'Strong grasp of PM role definition and core responsibilities',
        'Good understanding of product-led growth strategies',
        'Solid knowledge of product management artifacts',
      ],
      weaknesses: [
        'Confusion between outputs and outcomes — a critical PM concept',
      ],
      missedConcepts: [
        {
          concept: 'Outcomes vs Outputs',
          contentId: oid(CONTENT.pm_strategy[0]),
          timestamp: '4:32',
          suggestion: 'Re-watch the section on outcome-driven product management',
        },
      ],
      confidenceScore: 78,
      comparisonToPrevious: {
        previousScore: 70,
        improvement: 10,
        trend: 'improving',
      },
    },
    startedAt: daysAgo(3),
    completedAt: daysAgo(3),
    totalTime: 148,
    status: 'completed',
    createdAt: daysAgo(3),
    updatedAt: daysAgo(3),
  });

  // --- Quiz 2: Roadmapping (completed, scored 60%) ---
  const quiz2Id = new mongoose.Types.ObjectId();
  const quiz2Questions = [
    {
      _id: new mongoose.Types.ObjectId(),
      questionText: 'What is the primary purpose of a product roadmap?',
      questionType: 'conceptual',
      options: [
        { _id: new mongoose.Types.ObjectId(), label: 'A', text: 'To list every feature the team will build' },
        { _id: new mongoose.Types.ObjectId(), label: 'B', text: 'To communicate the strategic direction and planned initiatives over time' },
        { _id: new mongoose.Types.ObjectId(), label: 'C', text: 'To assign tasks to individual developers' },
        { _id: new mongoose.Types.ObjectId(), label: 'D', text: 'To track daily standup progress' },
      ],
      correctAnswer: 'B',
      explanation: 'A roadmap communicates strategy and direction — it\'s about themes and goals, not task-level details.',
      difficulty: 'easy',
      sourceContentId: oid(CONTENT.roadmapping[0]),
      concept: 'Roadmap purpose',
    },
    {
      _id: new mongoose.Types.ObjectId(),
      questionText: 'Which roadmap format is best for communicating with executives?',
      questionType: 'application',
      options: [
        { _id: new mongoose.Types.ObjectId(), label: 'A', text: 'Feature-based roadmap with exact dates' },
        { _id: new mongoose.Types.ObjectId(), label: 'B', text: 'Outcome-based roadmap with themes and time horizons' },
        { _id: new mongoose.Types.ObjectId(), label: 'C', text: 'Sprint backlog' },
        { _id: new mongoose.Types.ObjectId(), label: 'D', text: 'Gantt chart with all tasks' },
      ],
      correctAnswer: 'B',
      explanation: 'Executives care about strategic themes and business outcomes, not granular features or dates.',
      difficulty: 'medium',
      sourceContentId: oid(CONTENT.roadmapping[0]),
      concept: 'Roadmap audiences',
    },
    {
      _id: new mongoose.Types.ObjectId(),
      questionText: 'What is the "Now, Next, Later" roadmap framework?',
      questionType: 'recall',
      options: [
        { _id: new mongoose.Types.ObjectId(), label: 'A', text: 'A time-boxed quarterly planning approach' },
        { _id: new mongoose.Types.ObjectId(), label: 'B', text: 'A framework that organizes initiatives by confidence level and time horizon without fixed dates' },
        { _id: new mongoose.Types.ObjectId(), label: 'C', text: 'A daily prioritization method' },
        { _id: new mongoose.Types.ObjectId(), label: 'D', text: 'A release management process' },
      ],
      correctAnswer: 'B',
      explanation: 'Now-Next-Later avoids the false precision of dates, grouping work by confidence: Now (committed), Next (planned), Later (exploratory).',
      difficulty: 'medium',
      sourceContentId: oid(CONTENT.roadmapping[1]),
      concept: 'Now-Next-Later framework',
    },
    {
      _id: new mongoose.Types.ObjectId(),
      questionText: 'When should you update a product roadmap?',
      questionType: 'application',
      options: [
        { _id: new mongoose.Types.ObjectId(), label: 'A', text: 'Only at the beginning of each quarter' },
        { _id: new mongoose.Types.ObjectId(), label: 'B', text: 'Whenever new information changes priorities or strategic context' },
        { _id: new mongoose.Types.ObjectId(), label: 'C', text: 'Never — the initial roadmap should be followed exactly' },
        { _id: new mongoose.Types.ObjectId(), label: 'D', text: 'Only when the CEO requests it' },
      ],
      correctAnswer: 'B',
      explanation: 'Roadmaps are living documents. They should be updated as new data, feedback, or market changes shift priorities.',
      difficulty: 'easy',
      sourceContentId: oid(CONTENT.roadmapping[0]),
      concept: 'Roadmap iteration',
    },
    {
      _id: new mongoose.Types.ObjectId(),
      questionText: 'What is the biggest risk of a date-driven roadmap?',
      questionType: 'critical_thinking',
      options: [
        { _id: new mongoose.Types.ObjectId(), label: 'A', text: 'It creates clarity for stakeholders' },
        { _id: new mongoose.Types.ObjectId(), label: 'B', text: 'Teams treat dates as commitments, leading to scope cutting or deadline anxiety instead of outcome focus' },
        { _id: new mongoose.Types.ObjectId(), label: 'C', text: 'It\'s too simple to be useful' },
        { _id: new mongoose.Types.ObjectId(), label: 'D', text: 'Engineering teams don\'t understand dates' },
      ],
      correctAnswer: 'B',
      explanation: 'Date-driven roadmaps create false expectations. Teams rush to hit dates rather than focusing on delivering value.',
      difficulty: 'hard',
      sourceContentId: oid(CONTENT.roadmapping[1]),
      concept: 'Date-driven vs outcome-driven',
    },
  ];

  await db.collection('quizzes').insertOne({
    _id: quiz2Id,
    userId: oid(ADMIN_ID),
    title: 'Roadmapping Mastery',
    type: 'topic_consolidation',
    topic: 'roadmapping',
    sourceContentIds: CONTENT.roadmapping.map(oid),
    objectiveId: objectiveId,
    questions: quiz2Questions,
    totalQuestions: 5,
    timePerQuestion: 60,
    status: 'completed',
    deliveredAt: daysAgo(5),
    aiModel: 'gpt-4o',
    generatedAt: daysAgo(5),
    createdAt: daysAgo(5),
    updatedAt: daysAgo(5),
  });

  await db.collection('quizattempts').insertOne({
    _id: new mongoose.Types.ObjectId(),
    userId: oid(ADMIN_ID),
    quizId: quiz2Id,
    answers: [
      { questionIndex: 0, selectedAnswer: 'B', isCorrect: true, timeTaken: 15 },
      { questionIndex: 1, selectedAnswer: 'A', isCorrect: false, timeTaken: 40 },
      { questionIndex: 2, selectedAnswer: 'B', isCorrect: true, timeTaken: 32 },
      { questionIndex: 3, selectedAnswer: 'B', isCorrect: true, timeTaken: 20 },
      { questionIndex: 4, selectedAnswer: 'C', isCorrect: false, timeTaken: 50 },
    ],
    score: {
      total: 5,
      correct: 3,
      incorrect: 2,
      skipped: 0,
      percentage: 60,
    },
    topicBreakdown: [
      { topic: 'roadmapping', correct: 3, total: 5, percentage: 60 },
    ],
    analysis: {
      strengths: [
        'Good understanding of roadmap fundamentals and purpose',
        'Understands agile roadmap frameworks like Now-Next-Later',
      ],
      weaknesses: [
        'Struggles with stakeholder-specific roadmap formats',
        'Needs more depth on date-driven vs outcome-driven approaches',
      ],
      missedConcepts: [
        {
          concept: 'Roadmap audiences',
          contentId: oid(CONTENT.roadmapping[0]),
          timestamp: '3:15',
          suggestion: 'Review the section on tailoring roadmaps for different stakeholders',
        },
        {
          concept: 'Date-driven vs outcome-driven',
          contentId: oid(CONTENT.roadmapping[1]),
          timestamp: '2:48',
          suggestion: 'Watch the comparison between date-driven and theme-driven roadmaps',
        },
      ],
      confidenceScore: 62,
      comparisonToPrevious: null,
    },
    startedAt: daysAgo(5),
    completedAt: daysAgo(5),
    totalTime: 157,
    status: 'completed',
    createdAt: daysAgo(5),
    updatedAt: daysAgo(5),
  });

  // --- Quiz 3: Prioritization (completed, scored 40% — weak area) ---
  const quiz3Id = new mongoose.Types.ObjectId();
  const quiz3Questions = [
    {
      _id: new mongoose.Types.ObjectId(),
      questionText: 'What does the RICE framework stand for?',
      questionType: 'recall',
      options: [
        { _id: new mongoose.Types.ObjectId(), label: 'A', text: 'Reach, Impact, Confidence, Effort' },
        { _id: new mongoose.Types.ObjectId(), label: 'B', text: 'Revenue, Impact, Cost, Efficiency' },
        { _id: new mongoose.Types.ObjectId(), label: 'C', text: 'Reach, Innovation, Cost, Execution' },
        { _id: new mongoose.Types.ObjectId(), label: 'D', text: 'Risk, Impact, Complexity, Effort' },
      ],
      correctAnswer: 'A',
      explanation: 'RICE = Reach × Impact × Confidence ÷ Effort. It helps prioritize features quantitatively.',
      difficulty: 'easy',
      sourceContentId: oid(CONTENT.prioritization[0]),
      concept: 'RICE framework',
    },
    {
      _id: new mongoose.Types.ObjectId(),
      questionText: 'In the MoSCoW method, what does "Won\'t Have" mean?',
      questionType: 'conceptual',
      options: [
        { _id: new mongoose.Types.ObjectId(), label: 'A', text: 'Features that will never be built' },
        { _id: new mongoose.Types.ObjectId(), label: 'B', text: 'Features explicitly excluded from this iteration but may be reconsidered later' },
        { _id: new mongoose.Types.ObjectId(), label: 'C', text: 'Features with low user demand' },
        { _id: new mongoose.Types.ObjectId(), label: 'D', text: 'Features that are too expensive' },
      ],
      correctAnswer: 'B',
      explanation: 'Won\'t Have (this time) explicitly defers items — it doesn\'t mean never, just not now.',
      difficulty: 'medium',
      sourceContentId: oid(CONTENT.prioritization[0]),
      concept: 'MoSCoW method',
    },
    {
      _id: new mongoose.Types.ObjectId(),
      questionText: 'When is the Kano model most useful?',
      questionType: 'application',
      options: [
        { _id: new mongoose.Types.ObjectId(), label: 'A', text: 'When estimating development time' },
        { _id: new mongoose.Types.ObjectId(), label: 'B', text: 'When categorizing features by how they affect customer satisfaction' },
        { _id: new mongoose.Types.ObjectId(), label: 'C', text: 'When planning sprint capacity' },
        { _id: new mongoose.Types.ObjectId(), label: 'D', text: 'When writing user stories' },
      ],
      correctAnswer: 'B',
      explanation: 'The Kano model classifies features as Must-Be, Performance, or Delighters based on their impact on satisfaction.',
      difficulty: 'medium',
      sourceContentId: oid(CONTENT.prioritization[1]),
      concept: 'Kano model',
    },
    {
      _id: new mongoose.Types.ObjectId(),
      questionText: 'What is the key advantage of using a value vs effort matrix?',
      questionType: 'application',
      options: [
        { _id: new mongoose.Types.ObjectId(), label: 'A', text: 'It gives exact ROI numbers' },
        { _id: new mongoose.Types.ObjectId(), label: 'B', text: 'It provides a quick visual way to identify quick wins and big bets' },
        { _id: new mongoose.Types.ObjectId(), label: 'C', text: 'It replaces all other frameworks' },
        { _id: new mongoose.Types.ObjectId(), label: 'D', text: 'It eliminates the need for stakeholder input' },
      ],
      correctAnswer: 'B',
      explanation: 'The 2x2 matrix helps teams quickly identify: Quick Wins (high value, low effort), Big Bets (high value, high effort), Fill-ins, and Avoid.',
      difficulty: 'easy',
      sourceContentId: oid(CONTENT.prioritization[1]),
      concept: 'Value vs Effort matrix',
    },
    {
      _id: new mongoose.Types.ObjectId(),
      questionText: 'How should a PM handle stakeholders who disagree with prioritization decisions?',
      questionType: 'critical_thinking',
      options: [
        { _id: new mongoose.Types.ObjectId(), label: 'A', text: 'Always defer to the highest-ranking stakeholder' },
        { _id: new mongoose.Types.ObjectId(), label: 'B', text: 'Share the framework used, data behind decisions, and trade-offs transparently' },
        { _id: new mongoose.Types.ObjectId(), label: 'C', text: 'Ignore stakeholder feedback and follow the data only' },
        { _id: new mongoose.Types.ObjectId(), label: 'D', text: 'Build everything stakeholders request in parallel' },
      ],
      correctAnswer: 'B',
      explanation: 'Transparency about your framework and data builds trust. Stakeholders can challenge assumptions, leading to better decisions.',
      difficulty: 'hard',
      sourceContentId: oid(CONTENT.prioritization[0]),
      concept: 'Stakeholder management',
    },
  ];

  await db.collection('quizzes').insertOne({
    _id: quiz3Id,
    userId: oid(ADMIN_ID),
    title: 'Prioritization Deep Dive',
    type: 'topic_consolidation',
    topic: 'prioritization',
    sourceContentIds: CONTENT.prioritization.map(oid),
    objectiveId: objectiveId,
    questions: quiz3Questions,
    totalQuestions: 5,
    timePerQuestion: 60,
    status: 'completed',
    deliveredAt: daysAgo(6),
    aiModel: 'gpt-4o',
    generatedAt: daysAgo(6),
    createdAt: daysAgo(6),
    updatedAt: daysAgo(6),
  });

  await db.collection('quizattempts').insertOne({
    _id: new mongoose.Types.ObjectId(),
    userId: oid(ADMIN_ID),
    quizId: quiz3Id,
    answers: [
      { questionIndex: 0, selectedAnswer: 'A', isCorrect: true, timeTaken: 20 },
      { questionIndex: 1, selectedAnswer: 'A', isCorrect: false, timeTaken: 42 },
      { questionIndex: 2, selectedAnswer: 'D', isCorrect: false, timeTaken: 38 },
      { questionIndex: 3, selectedAnswer: 'B', isCorrect: true, timeTaken: 25 },
      { questionIndex: 4, selectedAnswer: 'A', isCorrect: false, timeTaken: 55 },
    ],
    score: {
      total: 5,
      correct: 2,
      incorrect: 3,
      skipped: 0,
      percentage: 40,
    },
    topicBreakdown: [
      { topic: 'prioritization', correct: 2, total: 5, percentage: 40 },
    ],
    analysis: {
      strengths: [
        'Knows the RICE framework components',
        'Understands value-effort matrix basics',
      ],
      weaknesses: [
        'Gaps in understanding MoSCoW method nuances',
        'Difficulty applying Kano model in context',
        'Stakeholder management during prioritization needs work',
      ],
      missedConcepts: [
        {
          concept: 'MoSCoW method',
          contentId: oid(CONTENT.prioritization[0]),
          timestamp: '8:20',
          suggestion: 'Re-watch the MoSCoW breakdown and practice categorizing features',
        },
        {
          concept: 'Kano model',
          contentId: oid(CONTENT.prioritization[1]),
          timestamp: '5:44',
          suggestion: 'Review the Kano model examples and try the customer satisfaction survey approach',
        },
        {
          concept: 'Stakeholder management',
          contentId: oid(CONTENT.prioritization[0]),
          timestamp: '15:30',
          suggestion: 'Study the stakeholder alignment techniques in the second half of this video',
        },
      ],
      confidenceScore: 42,
      comparisonToPrevious: null,
    },
    startedAt: daysAgo(6),
    completedAt: daysAgo(6),
    totalTime: 180,
    status: 'completed',
    createdAt: daysAgo(6),
    updatedAt: daysAgo(6),
  });

  // --- Quiz 4: PM Weekly Review (most recent, scored 75%) ---
  const quiz4Id = new mongoose.Types.ObjectId();
  const quiz4Questions = [
    {
      _id: new mongoose.Types.ObjectId(),
      questionText: 'What is the main purpose of user research in product management?',
      questionType: 'conceptual',
      options: [
        { _id: new mongoose.Types.ObjectId(), label: 'A', text: 'To validate the PM\'s existing assumptions' },
        { _id: new mongoose.Types.ObjectId(), label: 'B', text: 'To understand user needs, behaviors, and pain points to inform product decisions' },
        { _id: new mongoose.Types.ObjectId(), label: 'C', text: 'To create marketing materials' },
        { _id: new mongoose.Types.ObjectId(), label: 'D', text: 'To benchmark against competitors only' },
      ],
      correctAnswer: 'B',
      explanation: 'User research reveals actual user needs and behaviors, helping PMs make evidence-based decisions rather than assumptions.',
      difficulty: 'easy',
      sourceContentId: oid(CONTENT.user_research[0]),
      concept: 'User research purpose',
    },
    {
      _id: new mongoose.Types.ObjectId(),
      questionText: 'Which KPI is most directly tied to product-market fit?',
      questionType: 'application',
      options: [
        { _id: new mongoose.Types.ObjectId(), label: 'A', text: 'Page views' },
        { _id: new mongoose.Types.ObjectId(), label: 'B', text: 'Retention rate / cohort analysis' },
        { _id: new mongoose.Types.ObjectId(), label: 'C', text: 'Number of features shipped' },
        { _id: new mongoose.Types.ObjectId(), label: 'D', text: 'Team velocity' },
      ],
      correctAnswer: 'B',
      explanation: 'Retention is the strongest signal of product-market fit — if users keep coming back, the product is solving a real problem.',
      difficulty: 'medium',
      sourceContentId: oid(CONTENT.metrics[0]),
      concept: 'KPIs and PMF',
    },
    {
      _id: new mongoose.Types.ObjectId(),
      questionText: 'In a roadmap, what should "themes" represent?',
      questionType: 'recall',
      options: [
        { _id: new mongoose.Types.ObjectId(), label: 'A', text: 'Individual features with technical specifications' },
        { _id: new mongoose.Types.ObjectId(), label: 'B', text: 'Strategic areas of focus that map to business or user outcomes' },
        { _id: new mongoose.Types.ObjectId(), label: 'C', text: 'Bug categories' },
        { _id: new mongoose.Types.ObjectId(), label: 'D', text: 'Engineering sprints' },
      ],
      correctAnswer: 'B',
      explanation: 'Themes group related initiatives under strategic goals, keeping the roadmap focused on outcomes.',
      difficulty: 'medium',
      sourceContentId: oid(CONTENT.roadmapping[0]),
      concept: 'Roadmap themes',
    },
    {
      _id: new mongoose.Types.ObjectId(),
      questionText: 'What is a "Jobs to be Done" (JTBD) framework used for?',
      questionType: 'conceptual',
      options: [
        { _id: new mongoose.Types.ObjectId(), label: 'A', text: 'Hiring the right team members' },
        { _id: new mongoose.Types.ObjectId(), label: 'B', text: 'Understanding why customers "hire" a product to solve a specific need or situation' },
        { _id: new mongoose.Types.ObjectId(), label: 'C', text: 'Tracking employee productivity' },
        { _id: new mongoose.Types.ObjectId(), label: 'D', text: 'Defining job descriptions for PMs' },
      ],
      correctAnswer: 'B',
      explanation: 'JTBD focuses on the "job" customers hire a product to do — it shifts focus from demographics to motivation and context.',
      difficulty: 'medium',
      sourceContentId: oid(CONTENT.user_research[1]),
      concept: 'Jobs to be Done',
    },
  ];

  await db.collection('quizzes').insertOne({
    _id: quiz4Id,
    userId: oid(ADMIN_ID),
    title: 'Product Management Weekly Review',
    type: 'weekly_review',
    topic: 'product management',
    sourceContentIds: [...CONTENT.pm_strategy, ...CONTENT.roadmapping, ...CONTENT.user_research, ...CONTENT.metrics].map(oid),
    objectiveId: objectiveId,
    questions: quiz4Questions,
    totalQuestions: 4,
    timePerQuestion: 60,
    status: 'completed',
    deliveredAt: daysAgo(2),
    aiModel: 'gpt-4o',
    generatedAt: daysAgo(2),
    createdAt: daysAgo(2),
    updatedAt: daysAgo(2),
  });

  await db.collection('quizattempts').insertOne({
    _id: new mongoose.Types.ObjectId(),
    userId: oid(ADMIN_ID),
    quizId: quiz4Id,
    answers: [
      { questionIndex: 0, selectedAnswer: 'B', isCorrect: true, timeTaken: 12 },
      { questionIndex: 1, selectedAnswer: 'B', isCorrect: true, timeTaken: 28 },
      { questionIndex: 2, selectedAnswer: 'B', isCorrect: true, timeTaken: 22 },
      { questionIndex: 3, selectedAnswer: 'A', isCorrect: false, timeTaken: 40 },
    ],
    score: {
      total: 4,
      correct: 3,
      incorrect: 1,
      skipped: 0,
      percentage: 75,
    },
    topicBreakdown: [
      { topic: 'user research', correct: 1, total: 1, percentage: 100 },
      { topic: 'metrics', correct: 1, total: 1, percentage: 100 },
      { topic: 'roadmapping', correct: 1, total: 1, percentage: 100 },
      { topic: 'product management', correct: 0, total: 1, percentage: 0 },
    ],
    analysis: {
      strengths: [
        'Excellent cross-topic knowledge connecting research to strategy',
        'Strong understanding of KPIs and their relationship to PMF',
        'Good retention of roadmap concepts from earlier study',
      ],
      weaknesses: [
        'Still confused about advanced frameworks like Jobs to be Done',
      ],
      missedConcepts: [
        {
          concept: 'Jobs to be Done',
          contentId: oid(CONTENT.user_research[1]),
          timestamp: '6:22',
          suggestion: 'Watch the JTBD section again and try to write 3 job statements for a product you use daily',
        },
      ],
      confidenceScore: 74,
      comparisonToPrevious: {
        previousScore: 80,
        improvement: -5,
        trend: 'stable',
      },
    },
    startedAt: daysAgo(2),
    completedAt: daysAgo(2),
    totalTime: 102,
    status: 'completed',
    createdAt: daysAgo(2),
    updatedAt: daysAgo(2),
  });

  // --- Quiz 5: Ready but not taken (pending) ---
  const quiz5Id = new mongoose.Types.ObjectId();
  await db.collection('quizzes').insertOne({
    _id: quiz5Id,
    userId: oid(ADMIN_ID),
    title: 'User Research Methods',
    type: 'topic_consolidation',
    topic: 'user research',
    sourceContentIds: CONTENT.user_research.map(oid),
    objectiveId: objectiveId,
    questions: [
      {
        _id: new mongoose.Types.ObjectId(),
        questionText: 'What is the difference between qualitative and quantitative user research?',
        questionType: 'conceptual',
        options: [
          { _id: new mongoose.Types.ObjectId(), label: 'A', text: 'Qualitative uses surveys; quantitative uses interviews' },
          { _id: new mongoose.Types.ObjectId(), label: 'B', text: 'Qualitative explores the "why" through in-depth methods; quantitative measures the "what" with numerical data' },
          { _id: new mongoose.Types.ObjectId(), label: 'C', text: 'They are interchangeable terms' },
          { _id: new mongoose.Types.ObjectId(), label: 'D', text: 'Qualitative is more reliable than quantitative' },
        ],
        correctAnswer: 'B',
        explanation: 'Qualitative research (interviews, observations) reveals motivations and context. Quantitative (surveys, analytics) measures scale and frequency.',
        difficulty: 'easy',
        sourceContentId: oid(CONTENT.user_research[1]),
        concept: 'Research methods',
      },
      {
        _id: new mongoose.Types.ObjectId(),
        questionText: 'When should you conduct usability testing?',
        questionType: 'application',
        options: [
          { _id: new mongoose.Types.ObjectId(), label: 'A', text: 'Only after launch' },
          { _id: new mongoose.Types.ObjectId(), label: 'B', text: 'Throughout the product development lifecycle, starting with early prototypes' },
          { _id: new mongoose.Types.ObjectId(), label: 'C', text: 'Only when there are complaints' },
          { _id: new mongoose.Types.ObjectId(), label: 'D', text: 'Once per year during annual reviews' },
        ],
        correctAnswer: 'B',
        explanation: 'Continuous usability testing catches issues early when they are cheaper to fix.',
        difficulty: 'medium',
        sourceContentId: oid(CONTENT.user_research[0]),
        concept: 'Usability testing',
      },
      {
        _id: new mongoose.Types.ObjectId(),
        questionText: 'How many participants are typically sufficient for a qualitative usability study?',
        questionType: 'recall',
        options: [
          { _id: new mongoose.Types.ObjectId(), label: 'A', text: '100+' },
          { _id: new mongoose.Types.ObjectId(), label: 'B', text: '5-8 participants' },
          { _id: new mongoose.Types.ObjectId(), label: 'C', text: '50-75 participants' },
          { _id: new mongoose.Types.ObjectId(), label: 'D', text: '1 participant is enough' },
        ],
        correctAnswer: 'B',
        explanation: 'Nielsen\'s research shows 5 users find ~85% of usability problems. 5-8 is the sweet spot for qualitative studies.',
        difficulty: 'medium',
        sourceContentId: oid(CONTENT.user_research[1]),
        concept: 'Research sample size',
      },
    ],
    totalQuestions: 3,
    timePerQuestion: 60,
    status: 'ready',
    deliveredAt: hoursAgo(6),
    expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000), // expires in 48h
    aiModel: 'gpt-4o',
    generatedAt: hoursAgo(6),
    createdAt: hoursAgo(6),
    updatedAt: hoursAgo(6),
  });

  console.log(`  Quizzes: 4 completed + 1 ready, 4 attempts created`);

  // =====================
  // 6. QUIZ TRIGGERS
  // =====================
  await db.collection('quiztriggers').deleteMany({ userId: oid(ADMIN_ID) });
  const triggers = [
    {
      userId: oid(ADMIN_ID),
      triggerType: 'topic_threshold',
      topic: 'product strategy',
      sourceContentIds: CONTENT.pm_strategy.map(oid),
      quizId: quiz1Id,
      status: 'completed',
      createdAt: daysAgo(3),
      updatedAt: daysAgo(3),
    },
    {
      userId: oid(ADMIN_ID),
      triggerType: 'topic_threshold',
      topic: 'roadmapping',
      sourceContentIds: CONTENT.roadmapping.map(oid),
      quizId: quiz2Id,
      status: 'completed',
      createdAt: daysAgo(5),
      updatedAt: daysAgo(5),
    },
    {
      userId: oid(ADMIN_ID),
      triggerType: 'topic_threshold',
      topic: 'prioritization',
      sourceContentIds: [oid(CONTENT.prioritization[0])],
      quizId: quiz3Id,
      status: 'completed',
      createdAt: daysAgo(6),
      updatedAt: daysAgo(6),
    },
    {
      userId: oid(ADMIN_ID),
      triggerType: 'weekly_checkpoint',
      topic: 'product management',
      sourceContentIds: [...CONTENT.pm_strategy, ...CONTENT.roadmapping].map(oid),
      quizId: quiz4Id,
      status: 'completed',
      createdAt: daysAgo(2),
      updatedAt: daysAgo(2),
    },
    {
      userId: oid(ADMIN_ID),
      triggerType: 'topic_threshold',
      topic: 'user research',
      sourceContentIds: CONTENT.user_research.map(oid),
      quizId: quiz5Id,
      status: 'delivered',
      createdAt: hoursAgo(6),
      updatedAt: hoursAgo(6),
    },
  ];
  await db.collection('quiztriggers').insertMany(triggers);
  console.log('  Quiz triggers: 5 created');

  // =====================
  // 7. JOURNEY
  // =====================
  await db.collection('journeys').deleteMany({ userId: oid(ADMIN_ID) });

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  function weekStart(weeksFromNow) {
    const d = new Date(today);
    d.setDate(d.getDate() - d.getDay() + 1); // Monday of current week
    d.setDate(d.getDate() + (weeksFromNow * 7));
    return d;
  }

  function weekEnd(weeksFromNow) {
    const d = weekStart(weeksFromNow);
    d.setDate(d.getDate() + 6);
    return d;
  }

  const journeyId = new mongoose.Types.ObjectId();
  await db.collection('journeys').insertOne({
    _id: journeyId,
    userId: oid(ADMIN_ID),
    objectiveId: objectiveId,
    title: 'Senior Product Manager Upskilling Journey',
    status: 'active',
    phases: [
      {
        name: 'Foundation',
        type: 'foundation',
        order: 0,
        durationDays: 14,
        startDate: daysAgo(21),
        endDate: daysAgo(8),
        status: 'completed',
        objectives: ['Understand PM fundamentals', 'Learn strategy frameworks'],
        focusTopics: ['product management', 'product strategy'],
      },
      {
        name: 'Core Skills',
        type: 'building',
        order: 1,
        durationDays: 21,
        startDate: daysAgo(7),
        endDate: new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000),
        status: 'active',
        objectives: ['Master roadmapping and prioritization', 'Develop user research skills', 'Understand metrics'],
        focusTopics: ['roadmapping', 'prioritization', 'user research', 'metrics'],
      },
      {
        name: 'Advanced Strategy',
        type: 'strengthening',
        order: 2,
        durationDays: 21,
        startDate: new Date(today.getTime() + 15 * 24 * 60 * 60 * 1000),
        endDate: new Date(today.getTime() + 35 * 24 * 60 * 60 * 1000),
        status: 'upcoming',
        objectives: ['Product-market fit mastery', 'Growth and metrics', 'Cross-functional leadership'],
        focusTopics: ['product-market fit', 'metrics', 'entrepreneurship'],
      },
      {
        name: 'Business Acumen',
        type: 'mastery',
        order: 3,
        durationDays: 21,
        startDate: new Date(today.getTime() + 36 * 24 * 60 * 60 * 1000),
        endDate: new Date(today.getTime() + 56 * 24 * 60 * 60 * 1000),
        status: 'upcoming',
        objectives: ['Marketing fundamentals', 'Business model thinking', 'Fundraising awareness'],
        focusTopics: ['marketing', 'business model', 'fundraising'],
      },
    ],
    currentPhaseIndex: 1,
    weeklyPlans: [
      // Week 1 (completed) — Foundation
      {
        weekNumber: 1,
        startDate: daysAgo(21),
        endDate: daysAgo(15),
        phaseIndex: 0,
        status: 'completed',
        dailyAssignments: [
          { day: 1, contentIds: [oid(CONTENT.pm_strategy[0])], topics: ['product management'], estimatedTime: 6, completed: true, completedAt: daysAgo(20) },
          { day: 2, contentIds: [oid(CONTENT.pm_strategy[1])], topics: ['product strategy'], estimatedTime: 12, completed: true, completedAt: daysAgo(19) },
          { day: 3, contentIds: [oid(CONTENT.roadmapping[0])], topics: ['roadmapping'], estimatedTime: 7, completed: true, completedAt: daysAgo(18) },
          { day: 4, contentIds: [oid(CONTENT.roadmapping[1])], topics: ['roadmapping'], estimatedTime: 4, completed: true, completedAt: daysAgo(17) },
          { day: 5, contentIds: [oid(CONTENT.user_research[0])], topics: ['user research'], estimatedTime: 11, completed: true, completedAt: daysAgo(16) },
        ],
        scheduledQuiz: { dayOfWeek: 6, type: 'weekly_review', topics: ['product management', 'product strategy'], quizId: null, completed: true },
        goals: ['Understand PM fundamentals', 'Complete core PM strategy content'],
        outcomes: ['Solid foundation in PM concepts'],
      },
      // Week 2 (completed) — Foundation
      {
        weekNumber: 2,
        startDate: daysAgo(14),
        endDate: daysAgo(8),
        phaseIndex: 0,
        status: 'completed',
        dailyAssignments: [
          { day: 1, contentIds: [oid(CONTENT.user_research[1])], topics: ['user research'], estimatedTime: 14, completed: true, completedAt: daysAgo(13) },
          { day: 2, contentIds: [oid(CONTENT.startup[0])], topics: ['entrepreneurship'], estimatedTime: 9, completed: true, completedAt: daysAgo(12) },
          { day: 3, contentIds: [oid(CONTENT.business_model[0])], topics: ['business model'], estimatedTime: 7, completed: true, completedAt: daysAgo(11) },
          { day: 4, contentIds: [oid(CONTENT.digital_marketing[0])], topics: ['digital marketing'], estimatedTime: 18, completed: true, completedAt: daysAgo(10) },
          { day: 5, contentIds: [oid(CONTENT.pm_strategy[0])], topics: ['product management'], estimatedTime: 6, completed: true, completedAt: daysAgo(9) },
        ],
        scheduledQuiz: { dayOfWeek: 6, type: 'topic_consolidation', topics: ['roadmapping'], quizId: quiz2Id, completed: true },
        goals: ['Expand breadth of knowledge', 'Begin cross-domain learning'],
        outcomes: ['Strong performance in PM strategy quiz'],
      },
      // Week 3 (current) — Core Skills
      {
        weekNumber: 3,
        startDate: weekStart(0),
        endDate: weekEnd(0),
        phaseIndex: 1,
        status: 'active',
        dailyAssignments: [
          { day: 1, contentIds: [oid(CONTENT.prioritization[0])], topics: ['prioritization'], estimatedTime: 19, completed: true, completedAt: daysAgo(2) },
          { day: 2, contentIds: [oid(CONTENT.prioritization[1])], topics: ['prioritization'], estimatedTime: 10, completed: false },
          { day: 3, contentIds: [oid(CONTENT.pmf[0])], topics: ['product-market fit'], estimatedTime: 12, completed: false },
          { day: 4, contentIds: [oid(CONTENT.pmf[1])], topics: ['product-market fit'], estimatedTime: 10, completed: false },
          { day: 5, contentIds: [oid(CONTENT.metrics[0])], topics: ['metrics'], estimatedTime: 5, completed: false },
          { day: 6, contentIds: [oid(CONTENT.metrics[1])], topics: ['metrics'], estimatedTime: 7, completed: false },
        ],
        scheduledQuiz: { dayOfWeek: 7, type: 'weekly_review', topics: ['prioritization', 'product-market fit', 'metrics'], quizId: null, completed: false },
        goals: ['Master prioritization frameworks', 'Understand product-market fit signals', 'Learn key metrics and KPIs'],
        outcomes: [],
      },
      // Week 4 (upcoming) — Core Skills continued
      {
        weekNumber: 4,
        startDate: weekStart(1),
        endDate: weekEnd(1),
        phaseIndex: 1,
        status: 'upcoming',
        dailyAssignments: [
          { day: 1, contentIds: [oid(CONTENT.fundraising[0])], topics: ['fundraising'], estimatedTime: 5, completed: false },
          { day: 2, contentIds: [oid(CONTENT.fundraising[1])], topics: ['fundraising'], estimatedTime: 12, completed: false },
          { day: 3, contentIds: [oid(CONTENT.leadership[0])], topics: ['leadership'], estimatedTime: 15, completed: false },
          { day: 4, contentIds: [oid(CONTENT.leadership[1])], topics: ['leadership'], estimatedTime: 13, completed: false },
          { day: 5, contentIds: [oid(CONTENT.lean_startup[0])], topics: ['lean startup'], estimatedTime: 14, completed: false },
        ],
        scheduledQuiz: { dayOfWeek: 6, type: 'weekly_review', topics: ['entrepreneurship', 'fundraising', 'leadership'], quizId: null, completed: false },
        goals: ['Build entrepreneurial mindset', 'Understand fundraising landscape'],
        outcomes: [],
      },
      // Week 5 (upcoming)
      {
        weekNumber: 5,
        startDate: weekStart(2),
        endDate: weekEnd(2),
        phaseIndex: 1,
        status: 'upcoming',
        dailyAssignments: [
          { day: 1, contentIds: [oid(CONTENT.lean_startup[1])], topics: ['lean startup'], estimatedTime: 8, completed: false },
          { day: 2, contentIds: [oid(CONTENT.business_model[1])], topics: ['business model'], estimatedTime: 16, completed: false },
          { day: 3, contentIds: [oid(CONTENT.startup[1])], topics: ['startup'], estimatedTime: 11, completed: false },
          { day: 4, contentIds: [oid(CONTENT.branding[0])], topics: ['branding'], estimatedTime: 12, completed: false },
          { day: 5, contentIds: [oid(CONTENT.branding[1])], topics: ['branding'], estimatedTime: 11, completed: false },
        ],
        scheduledQuiz: { dayOfWeek: 6, type: 'milestone_assessment', topics: ['product management', 'entrepreneurship'], quizId: null, completed: false },
        goals: ['Complete lean startup fundamentals', 'Begin marketing knowledge'],
        outcomes: [],
      },
    ],
    currentWeek: 3,
    milestones: [
      {
        title: 'PM Foundation Complete',
        type: 'phase_completion',
        targetCriteria: { targetScore: 70, targetTopic: 'product management' },
        scheduledDate: daysAgo(8),
        status: 'completed',
        completedAt: daysAgo(8),
        result: { score: 78 },
      },
      {
        title: 'Score 80% on Prioritization',
        type: 'score_target',
        targetCriteria: { targetScore: 80, targetTopic: 'prioritization' },
        scheduledDate: new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000),
        status: 'in_progress',
      },
      {
        title: '7-Day Learning Streak',
        type: 'streak',
        targetCriteria: { streakDays: 7 },
        scheduledDate: new Date(today.getTime() + 5 * 24 * 60 * 60 * 1000),
        status: 'in_progress',
      },
      {
        title: 'Core Skills Phase Complete',
        type: 'phase_completion',
        targetCriteria: { targetScore: 70 },
        scheduledDate: new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000),
        status: 'upcoming',
      },
      {
        title: 'Master Product-Market Fit',
        type: 'topic_completion',
        targetCriteria: { targetScore: 85, targetTopic: 'product-market fit' },
        scheduledDate: new Date(today.getTime() + 21 * 24 * 60 * 60 * 1000),
        status: 'upcoming',
      },
    ],
    adaptationHistory: [
      {
        date: daysAgo(6),
        trigger: 'quiz_score_low',
        changes: 'Added extra prioritization content after 40% quiz score',
        details: { topic: 'prioritization', action: 'added_content', quizScore: 40 },
      },
    ],
    progress: {
      overallPercentage: 38,
      contentConsumed: 10,
      contentAssigned: 26,
      quizzesCompleted: 4,
      quizzesAssigned: 5,
      milestonesCompleted: 1,
      milestonesTotal: 5,
      currentStreak: 3,
      longestStreak: 5,
    },
    aiModel: 'gpt-4o',
    generatedAt: daysAgo(21),
    createdAt: daysAgo(21),
    updatedAt: daysAgo(1),
  });
  console.log('  Journey created with 5 weekly plans, 5 milestones');

  // =====================
  // 8. TODAY PLAN
  // =====================
  await db.collection('todayplans').deleteMany({ userId: oid(ADMIN_ID) });

  const todayDate = new Date();
  todayDate.setHours(0, 0, 0, 0);

  await db.collection('todayplans').insertOne({
    userId: oid(ADMIN_ID),
    journeyId: journeyId,
    date: todayDate,
    contentIds: [
      oid(CONTENT.prioritization[1]),  // Today's main content
      oid(CONTENT.pmf[0]),             // Continue in-progress
    ],
    topics: ['prioritization', 'product-market fit'],
    estimatedTime: 22,
    status: 'in_progress',
    completedCount: 0,
    createdAt: todayDate,
    updatedAt: new Date(),
  });
  console.log('  Today plan created');

  // =====================
  // SUMMARY
  // =====================
  console.log('\n=== SEED COMPLETE ===');
  console.log('Admin user: 699d8aeca7eb4b450fbd22e0');
  console.log('Objective:', objectiveId.toString());
  console.log('Journey:', journeyId.toString());
  console.log('Content progress: 10 completed + 4 in-progress');
  console.log('Knowledge profile: 9 topics with mastery data');
  console.log('Consumption graph: 7 topic nodes, 7 edges');
  console.log('Quizzes: 4 completed + 1 ready');
  console.log('Quiz attempts: 4 (scores: 80%, 60%, 40%, 75%)');
  console.log('Quiz triggers: 5');
  console.log('Milestones: 1 completed, 2 in-progress, 2 upcoming');

  await mongoose.disconnect();
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
