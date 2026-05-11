const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

const openaiPath = require.resolve('../../config/openai');
const fakeOpenAI = {
  chat: { completions: { create: async () => ({}) } },
};
require.cache[openaiPath] = { exports: fakeOpenAI };

// Stub taskCatalogService so generate()'s post-processor doesn't try to hit MongoDB.
// Individual tests below override resolveTopic to assert specific shapes.
const taskCatalogPath = require.resolve('../plan/taskCatalogService');
const fakeTaskCatalog = {
  resolveTopic: async () => ({ quizId: null, contentId: null }),
  _internal: {},
};
require.cache[taskCatalogPath] = { exports: fakeTaskCatalog };

delete require.cache[require.resolve('./planGenerationService')];
const svc = require('./planGenerationService');

const baseInput = () => ({
  userId: new mongoose.Types.ObjectId(),
  objectiveId: new mongoose.Types.ObjectId(),
  diagnosticAttemptId: new mongoose.Types.ObjectId(),
  objectiveType: 'interview_preparation',
  specificsCanonical: { targetRole: 'Product Manager', targetCompany: 'Razorpay' },
  companyProfile: null,
  timeline: 8,
  weeklyCommitHours: 6,
  topicResults: [
    { canonicalName: 'product-strategy', selfRating: 'familiar', measuredScore: 35, measuredBand: 'familiar', calibrationDelta: -7, calibrationClass: 'well-calibrated', questionsAsked: 3, answerPattern: { easy: 1, medium: 1, hard: 0 }, isFutureProofing: false },
    { canonicalName: 'stakeholder-mgmt', selfRating: 'proficient', measuredScore: 30, measuredBand: 'novice', calibrationDelta: -37, calibrationClass: 'overestimates', questionsAsked: 3, answerPattern: { easy: 1, medium: 0, hard: 0 }, isFutureProofing: false },
    { canonicalName: 'ai-product-strategy', selfRating: 'novice', measuredScore: 20, measuredBand: 'novice', calibrationDelta: 5, calibrationClass: 'well-calibrated', questionsAsked: 2, answerPattern: { easy: 0, medium: 0, hard: 0 }, isFutureProofing: true },
  ],
  userMilestoneHints: [],
});

test('planGenerationService.generate: builds plan from LLM JSON', async () => {
  fakeOpenAI.chat.completions.create = async () => ({
    choices: [{ message: { content: JSON.stringify({
      planHeadline: 'Eight weeks to interview-ready PM at Razorpay.',
      bufferRecommendation: "We've left 15% buffer for life events.",
      weeklySchedule: [
        { week: 1, weeklyGoal: 'Foundations', allocations: [
          { topicCanonicalName: 'stakeholder-mgmt', hours: 3, focusActivity: 'Foundations module' },
          { topicCanonicalName: 'product-strategy', hours: 2, focusActivity: 'Read + reflect' },
          { topicCanonicalName: 'ai-product-strategy', hours: 1, focusActivity: 'Build with LLMs primer' },
        ]},
        { week: 2, weeklyGoal: 'Apply', allocations: [
          { topicCanonicalName: 'stakeholder-mgmt', hours: 3, focusActivity: 'Practice' },
          { topicCanonicalName: 'product-strategy', hours: 2, focusActivity: 'Cases' },
          { topicCanonicalName: 'ai-product-strategy', hours: 1, focusActivity: 'Tools' },
        ]},
      ],
      milestones: [
        { week: 4, title: 'Mock behavioral', measurableCriteria: 'Score 4/5 STAR clarity', isUserStated: false },
      ],
    })}}],
    usage: { total_tokens: 1500 },
  });
  const out = await svc.generate(baseInput());
  assert.strictEqual(out.source, 'llm-generated');
  assert.strictEqual(out.weeklySchedule.length, 2);
  assert.strictEqual(out.milestones[0].title, 'Mock behavioral');
  assert.ok(out.planHeadline.includes('Razorpay'));
  assert.ok(out.estimatedTotalHours > 0);
});

test('planGenerationService.generate: falls back to template on LLM error', async () => {
  fakeOpenAI.chat.completions.create = async () => { throw new Error('ETIMEDOUT'); };
  const out = await svc.generate(baseInput());
  assert.strictEqual(out.source, 'template');
  assert.ok(out.weeklySchedule.length === 8, 'template uses full timeline weeks');
  assert.ok(out.planHeadline.length > 0);
});

test('planGenerationService.generate: caps total hours at 0.85 of capacity', async () => {
  fakeOpenAI.chat.completions.create = async () => ({
    choices: [{ message: { content: JSON.stringify({
      planHeadline: 'X',
      bufferRecommendation: 'Y',
      weeklySchedule: Array.from({ length: 8 }, (_, i) => ({
        week: i + 1,
        weeklyGoal: 'g',
        allocations: [
          { topicCanonicalName: 'product-strategy', hours: 8, focusActivity: 'a' },
          { topicCanonicalName: 'stakeholder-mgmt', hours: 8, focusActivity: 'a' },
        ],
      })),
      milestones: [],
    })}}],
  });
  const input = baseInput();
  const cap = input.timeline * input.weeklyCommitHours * 0.85;
  const out = await svc.generate(input);
  assert.ok(out.estimatedTotalHours <= cap + 0.5, `total ${out.estimatedTotalHours} > cap ${cap}`);
});

test('planGenerationService.generate: applies +20% to overestimates topics in template', async () => {
  fakeOpenAI.chat.completions.create = async () => { throw new Error('fail'); };
  const out = await svc.generate(baseInput());
  const totalsByTopic = {};
  out.weeklySchedule.forEach(w => w.allocations.forEach(a => {
    totalsByTopic[a.topicCanonicalName] = (totalsByTopic[a.topicCanonicalName] || 0) + a.hours;
  }));
  assert.ok(totalsByTopic['stakeholder-mgmt'] > totalsByTopic['product-strategy'],
    'overestimates topic should receive more hours');
});

test('planGenerationService.generate: future-proofing topics get >=8% of total', async () => {
  fakeOpenAI.chat.completions.create = async () => { throw new Error('fail'); };
  const out = await svc.generate(baseInput());
  const totalsByTopic = {};
  out.weeklySchedule.forEach(w => w.allocations.forEach(a => {
    totalsByTopic[a.topicCanonicalName] = (totalsByTopic[a.topicCanonicalName] || 0) + a.hours;
  }));
  const aiShare = (totalsByTopic['ai-product-strategy'] || 0) / out.estimatedTotalHours;
  assert.ok(aiShare >= 0.08, `future-proofing share ${aiShare} should be >= 0.08`);
});

test('planGenerationService.buildTemplate: novice topics appear in week 1', async () => {
  fakeOpenAI.chat.completions.create = async () => { throw new Error('fail'); };
  const out = await svc.generate(baseInput());
  const week1Topics = out.weeklySchedule[0].allocations.map(a => a.topicCanonicalName);
  assert.ok(week1Topics.includes('stakeholder-mgmt'), 'novice topic in week 1');
});

test('generate: post-processes weeklySchedule to include tasks[] per topic', async () => {
  const planService = require('./planGenerationService');
  const mongoose = require('mongoose');

  // Stub OpenAI to throw so generate() falls back to template (deterministic).
  const openai = require('../../config/openai');
  const origCreate = openai.chat.completions.create;
  openai.chat.completions.create = async () => { throw new Error('test stub'); };

  const taskCatalogService = require('../plan/taskCatalogService');
  const origResolve = taskCatalogService.resolveTopic;
  taskCatalogService.resolveTopic = async ({ topicCanonicalName }) => {
    if (topicCanonicalName === 'product-strategy') {
      return {
        quizId: '64aaaaaaaaaaaaaaaaaaaaaa',
        quizMinutes: 10,
        contentId: '64bbbbbbbbbbbbbbbbbbbbbb',
        contentType: 'article',
        contentMinutes: 12,
      };
    }
    return { quizId: null, contentId: null };
  };

  try {
    const out = await planService.generate({
      userId: new mongoose.Types.ObjectId(),
      objectiveId: new mongoose.Types.ObjectId(),
      diagnosticAttemptId: new mongoose.Types.ObjectId(),
      objectiveType: 'interview_preparation',
      specificsCanonical: { targetRole: 'product-manager' },
      timeline: 4,
      weeklyCommitHours: 5,
      topicResults: [
        { canonicalName: 'product-strategy', selfRating: 'familiar', measuredScore: 50,
          measuredBand: 'developing', calibrationDelta: 0, calibrationClass: 'well-calibrated',
          questionsAsked: 4, answerPattern: {}, isFutureProofing: false },
      ],
    });

    assert.ok(Array.isArray(out.weeklySchedule));
    assert.ok(out.weeklySchedule.length > 0);
    const w0 = out.weeklySchedule[0];
    assert.ok(Array.isArray(w0.tasks), 'each week should have a tasks[] array');
    assert.ok(w0.tasks.length >= 2, `expected quiz+content tasks, got ${w0.tasks.length}`);

    const quizTask = w0.tasks.find(t => t.type === 'quiz');
    const contentTask = w0.tasks.find(t => t.type === 'in_app_content');
    assert.ok(quizTask, 'quiz task missing');
    assert.ok(contentTask, 'in_app_content task missing');
    assert.strictEqual(quizTask.payload.quizId, '64aaaaaaaaaaaaaaaaaaaaaa');
    assert.strictEqual(quizTask.completion.mode, 'auto');
    assert.strictEqual(quizTask.progress.status, 'pending');
    assert.strictEqual(contentTask.payload.contentId, '64bbbbbbbbbbbbbbbbbbbbbb');
    assert.strictEqual(contentTask.topic.canonicalName, 'product-strategy');
  } finally {
    openai.chat.completions.create = origCreate;
    taskCatalogService.resolveTopic = origResolve;
  }
});

test('generate: emits no quiz/content task for a topic with no quiz and no content (manual fallback fires)', async () => {
  const planService = require('./planGenerationService');
  const mongoose = require('mongoose');

  const openai = require('../../config/openai');
  const origCreate = openai.chat.completions.create;
  openai.chat.completions.create = async () => { throw new Error('test stub'); };

  const taskCatalogService = require('../plan/taskCatalogService');
  const origResolve = taskCatalogService.resolveTopic;
  taskCatalogService.resolveTopic = async () => ({ quizId: null, contentId: null });

  try {
    const out = await planService.generate({
      userId: new mongoose.Types.ObjectId(),
      objectiveId: new mongoose.Types.ObjectId(),
      diagnosticAttemptId: new mongoose.Types.ObjectId(),
      objectiveType: 'interview_preparation',
      specificsCanonical: { targetRole: 'pm' },
      timeline: 2,
      weeklyCommitHours: 5,
      topicResults: [
        { canonicalName: 'unmapped-topic', selfRating: 'familiar', measuredScore: 40,
          measuredBand: 'developing', calibrationDelta: 0, calibrationClass: 'well-calibrated',
          questionsAsked: 4, answerPattern: {}, isFutureProofing: false },
      ],
    });
    out.weeklySchedule.forEach(w => {
      const tasks = w.tasks || [];
      assert.ok(!tasks.some(t => t.type === 'quiz'), `week ${w.week} should have no quiz task`);
      assert.ok(!tasks.some(t => t.type === 'in_app_content'), `week ${w.week} should have no in_app_content task`);
      // Phase 6: ai_interview is now objective-level, so it does NOT cover the topic.
      // Manual fallback fires for the unmapped topic.
      assert.ok(tasks.some(t => t.type === 'manual'), `week ${w.week} should emit manual when nothing else resolved for the topic`);
    });
  } finally {
    openai.chat.completions.create = origCreate;
    taskCatalogService.resolveTopic = origResolve;
  }
});

test('generate: emits ONE ai_interview task per week (not per topic) for interview_preparation', async () => {
  process.env.FEATURE_EXTERNAL_CONTENT_JUDGE = 'false';
  const planService = require('./planGenerationService');
  const mongoose = require('mongoose');
  const openai = require('../../config/openai');
  const origCreate = openai.chat.completions.create;
  openai.chat.completions.create = async () => { throw new Error('test stub'); };
  const taskCatalogService = require('../plan/taskCatalogService');
  const origResolve = taskCatalogService.resolveTopic;
  taskCatalogService.resolveTopic = async () => ({ quizId: 'q', quizMinutes: 8, contentId: 'c', contentType: 'article', contentMinutes: 12 });

  try {
    const out = await planService.generate({
      userId: new mongoose.Types.ObjectId(),
      objectiveId: new mongoose.Types.ObjectId(),
      diagnosticAttemptId: new mongoose.Types.ObjectId(),
      objectiveType: 'interview_preparation',
      specificsCanonical: { targetRole: 'product manager' },
      timeline: 4, weeklyCommitHours: 5,
      topicResults: [
        { canonicalName: 'a', selfRating: 'familiar', measuredScore: 50, measuredBand: 'developing', calibrationDelta: 0, calibrationClass: 'well-calibrated', questionsAsked: 4, answerPattern: {}, isFutureProofing: false },
        { canonicalName: 'b', selfRating: 'familiar', measuredScore: 50, measuredBand: 'developing', calibrationDelta: 0, calibrationClass: 'well-calibrated', questionsAsked: 4, answerPattern: {}, isFutureProofing: false },
      ],
    });
    for (const w of out.weeklySchedule) {
      const interviewTasks = w.tasks.filter(t => t.type === 'ai_interview');
      assert.strictEqual(interviewTasks.length, 1, `week ${w.week} should have 1 ai_interview, got ${interviewTasks.length}`);
      assert.strictEqual(interviewTasks[0].topic.canonicalName, '_objective');
      assert.ok(Array.isArray(interviewTasks[0].payload.topicHints) && interviewTasks[0].payload.topicHints.length > 0);
    }
    // PM role: even weeks case_study, odd weeks placement_behavioral
    const w1 = out.weeklySchedule[0]; // week 1
    const w2 = out.weeklySchedule[1]; // week 2
    assert.strictEqual(w1.tasks.find(t => t.type === 'ai_interview').payload.scenario, 'placement_behavioral');
    assert.strictEqual(w2.tasks.find(t => t.type === 'ai_interview').payload.scenario, 'case_study');
  } finally {
    openai.chat.completions.create = origCreate;
    taskCatalogService.resolveTopic = origResolve;
  }
});

test('generate: career_switch with no targetRole does NOT emit interview tasks', async () => {
  const planService = require('./planGenerationService');
  const mongoose = require('mongoose');
  const openai = require('../../config/openai');
  const origCreate = openai.chat.completions.create;
  openai.chat.completions.create = async () => { throw new Error('test stub'); };
  const taskCatalogService = require('../plan/taskCatalogService');
  const origResolve = taskCatalogService.resolveTopic;
  taskCatalogService.resolveTopic = async () => ({ quizId: 'q', contentId: null });

  try {
    const out = await planService.generate({
      userId: new mongoose.Types.ObjectId(),
      objectiveId: new mongoose.Types.ObjectId(),
      diagnosticAttemptId: new mongoose.Types.ObjectId(),
      objectiveType: 'career_switch',
      specificsCanonical: {}, // no targetRole
      timeline: 4, weeklyCommitHours: 5,
      topicResults: [{ canonicalName: 'a', selfRating: 'familiar', measuredScore: 50, measuredBand: 'developing', calibrationDelta: 0, calibrationClass: 'well-calibrated', questionsAsked: 4, answerPattern: {}, isFutureProofing: false }],
    });
    for (const w of out.weeklySchedule) {
      assert.strictEqual(w.tasks.filter(t => t.type === 'ai_interview').length, 0);
    }
  } finally {
    openai.chat.completions.create = origCreate;
    taskCatalogService.resolveTopic = origResolve;
  }
});

test('generate: upskilling WITH targetRole emits interview tasks (Phase 6 follow-up)', async () => {
  process.env.FEATURE_EXTERNAL_CONTENT_JUDGE = 'false';
  const planService = require('./planGenerationService');
  const mongoose = require('mongoose');
  const openai = require('../../config/openai');
  const origCreate = openai.chat.completions.create;
  openai.chat.completions.create = async () => { throw new Error('test stub'); };
  const taskCatalogService = require('../plan/taskCatalogService');
  const origResolve = taskCatalogService.resolveTopic;
  taskCatalogService.resolveTopic = async () => ({ quizId: 'q', quizMinutes: 8, contentId: 'c', contentType: 'article', contentMinutes: 12 });

  try {
    const out = await planService.generate({
      userId: new mongoose.Types.ObjectId(),
      objectiveId: new mongoose.Types.ObjectId(),
      diagnosticAttemptId: new mongoose.Types.ObjectId(),
      objectiveType: 'upskilling',
      // Use raw specifics (not specificsCanonical) to also exercise the fallback
      specifics: { targetRole: 'product manager' },
      timeline: 4, weeklyCommitHours: 5,
      topicResults: [
        { canonicalName: 'a', selfRating: 'familiar', measuredScore: 50, measuredBand: 'developing', calibrationDelta: 0, calibrationClass: 'well-calibrated', questionsAsked: 4, answerPattern: {}, isFutureProofing: false },
        { canonicalName: 'b', selfRating: 'familiar', measuredScore: 50, measuredBand: 'developing', calibrationDelta: 0, calibrationClass: 'well-calibrated', questionsAsked: 4, answerPattern: {}, isFutureProofing: false },
      ],
    });
    let totalInterview = 0;
    for (const w of out.weeklySchedule) {
      const interviewTasks = w.tasks.filter(t => t.type === 'ai_interview');
      assert.strictEqual(interviewTasks.length, 1, `week ${w.week} should have 1 ai_interview, got ${interviewTasks.length}`);
      assert.strictEqual(interviewTasks[0].topic.canonicalName, '_objective');
      totalInterview += interviewTasks.length;
    }
    assert.ok(totalInterview >= 1, 'expected at least 1 ai_interview task overall');
  } finally {
    openai.chat.completions.create = origCreate;
    taskCatalogService.resolveTopic = origResolve;
  }
});

test('generate: upskilling WITHOUT targetRole still does NOT emit interview tasks', async () => {
  const planService = require('./planGenerationService');
  const mongoose = require('mongoose');
  const openai = require('../../config/openai');
  const origCreate = openai.chat.completions.create;
  openai.chat.completions.create = async () => { throw new Error('test stub'); };
  const taskCatalogService = require('../plan/taskCatalogService');
  const origResolve = taskCatalogService.resolveTopic;
  taskCatalogService.resolveTopic = async () => ({ quizId: 'q', contentId: 'c', contentType: 'article', quizMinutes: 8, contentMinutes: 12 });

  try {
    const out = await planService.generate({
      userId: new mongoose.Types.ObjectId(),
      objectiveId: new mongoose.Types.ObjectId(),
      diagnosticAttemptId: new mongoose.Types.ObjectId(),
      objectiveType: 'upskilling',
      specificsCanonical: {}, // no targetRole
      timeline: 4, weeklyCommitHours: 5,
      topicResults: [{ canonicalName: 'a', selfRating: 'familiar', measuredScore: 50, measuredBand: 'developing', calibrationDelta: 0, calibrationClass: 'well-calibrated', questionsAsked: 4, answerPattern: {}, isFutureProofing: false }],
    });
    for (const w of out.weeklySchedule) {
      assert.strictEqual(w.tasks.filter(t => t.type === 'ai_interview').length, 0);
    }
  } finally {
    openai.chat.completions.create = origCreate;
    taskCatalogService.resolveTopic = origResolve;
  }
});

test('generate: scenario selector falls back to specifics.targetRole when specificsCanonical is empty', async () => {
  process.env.FEATURE_EXTERNAL_CONTENT_JUDGE = 'false';
  const planService = require('./planGenerationService');
  const mongoose = require('mongoose');
  const openai = require('../../config/openai');
  const origCreate = openai.chat.completions.create;
  openai.chat.completions.create = async () => { throw new Error('test stub'); };
  const taskCatalogService = require('../plan/taskCatalogService');
  const origResolve = taskCatalogService.resolveTopic;
  taskCatalogService.resolveTopic = async () => ({ quizId: 'q', quizMinutes: 8, contentId: 'c', contentType: 'article', contentMinutes: 12 });

  try {
    const out = await planService.generate({
      userId: new mongoose.Types.ObjectId(),
      objectiveId: new mongoose.Types.ObjectId(),
      diagnosticAttemptId: new mongoose.Types.ObjectId(),
      objectiveType: 'interview_preparation',
      specificsCanonical: {}, // empty — must fall back to specifics.targetRole
      specifics: { targetRole: 'data engineer' },
      timeline: 4, weeklyCommitHours: 5,
      topicResults: [
        { canonicalName: 'a', selfRating: 'familiar', measuredScore: 50, measuredBand: 'developing', calibrationDelta: 0, calibrationClass: 'well-calibrated', questionsAsked: 4, answerPattern: {}, isFutureProofing: false },
        { canonicalName: 'b', selfRating: 'familiar', measuredScore: 50, measuredBand: 'developing', calibrationDelta: 0, calibrationClass: 'well-calibrated', questionsAsked: 4, answerPattern: {}, isFutureProofing: false },
      ],
    });
    // engineer regex: week 1 (odd) -> placement_behavioral, week 2 (even) -> placement_technical
    const w1 = out.weeklySchedule[0];
    const w2 = out.weeklySchedule[1];
    assert.strictEqual(w1.tasks.find(t => t.type === 'ai_interview').payload.scenario, 'placement_behavioral');
    assert.strictEqual(w2.tasks.find(t => t.type === 'ai_interview').payload.scenario, 'placement_technical');
  } finally {
    openai.chat.completions.create = origCreate;
    taskCatalogService.resolveTopic = origResolve;
  }
});

test('generate: emits competition task for every topic regardless of objective', async () => {
  const planService = require('./planGenerationService');
  const mongoose = require('mongoose');
  const openai = require('../../config/openai');
  const origCreate = openai.chat.completions.create;
  openai.chat.completions.create = async () => { throw new Error('test stub'); };

  const taskCatalogService = require('../plan/taskCatalogService');
  const origResolve = taskCatalogService.resolveTopic;
  taskCatalogService.resolveTopic = async () => ({ quizId: 'qz1', quizMinutes: 10, contentId: null });

  try {
    const out = await planService.generate({
      userId: new mongoose.Types.ObjectId(),
      objectiveId: new mongoose.Types.ObjectId(),
      diagnosticAttemptId: new mongoose.Types.ObjectId(),
      objectiveType: 'casual_learning',
      specificsCanonical: {},
      timeline: 2, weeklyCommitHours: 5,
      topicResults: [{ canonicalName: 'general-knowledge', selfRating: 'familiar', measuredScore: 50, measuredBand: 'developing', calibrationDelta: 0, calibrationClass: 'well-calibrated', questionsAsked: 4, answerPattern: {}, isFutureProofing: false }],
    });
    const w0 = out.weeklySchedule[0];
    const competitionTask = w0.tasks.find(t => t.type === 'competition');
    assert.ok(competitionTask, 'every topic should emit a competition task');
    assert.strictEqual(competitionTask.payload.topicCanonicalName, 'general-knowledge');
  } finally {
    openai.chat.completions.create = origCreate;
    taskCatalogService.resolveTopic = origResolve;
  }
});

test('generate: emits manual fallback when topic has no quiz/content/interview', async () => {
  const planService = require('./planGenerationService');
  const mongoose = require('mongoose');
  const openai = require('../../config/openai');
  const origCreate = openai.chat.completions.create;
  openai.chat.completions.create = async () => { throw new Error('test stub'); };

  const taskCatalogService = require('../plan/taskCatalogService');
  const origResolve = taskCatalogService.resolveTopic;
  taskCatalogService.resolveTopic = async () => ({ quizId: null, contentId: null });

  try {
    const out = await planService.generate({
      userId: new mongoose.Types.ObjectId(),
      objectiveId: new mongoose.Types.ObjectId(),
      diagnosticAttemptId: new mongoose.Types.ObjectId(),
      objectiveType: 'upskilling',
      specificsCanonical: { targetSkill: 'rare-skill' },
      timeline: 2, weeklyCommitHours: 5,
      topicResults: [{ canonicalName: 'unmapped-topic', selfRating: 'familiar', measuredScore: 50, measuredBand: 'developing', calibrationDelta: 0, calibrationClass: 'well-calibrated', questionsAsked: 4, answerPattern: {}, isFutureProofing: false }],
    });
    const w0 = out.weeklySchedule[0];
    const manualTask = w0.tasks.find(t => t.type === 'manual');
    assert.ok(manualTask, 'should emit manual fallback when nothing else resolved');
    assert.strictEqual(manualTask.completion.mode, 'manual');
    assert.strictEqual(manualTask.completion.requiresSelfRating, true);
    assert.ok(manualTask.payload.title, 'manual task needs a title');
    assert.ok(manualTask.payload.estimatedMinutes > 0);
  } finally {
    openai.chat.completions.create = origCreate;
    taskCatalogService.resolveTopic = origResolve;
  }
});

test('generate: emits external_link tasks when judge returns links AND feature flag is on', async () => {
  process.env.FEATURE_EXTERNAL_CONTENT_JUDGE = 'true';
  const planService = require('./planGenerationService');
  const mongoose = require('mongoose');

  const openai = require('../../config/openai');
  const origCreate = openai.chat.completions.create;
  openai.chat.completions.create = async () => { throw new Error('test stub'); };

  const taskCatalogService = require('../plan/taskCatalogService');
  const origResolve = taskCatalogService.resolveTopic;
  taskCatalogService.resolveTopic = async () => ({
    quizId: 'qz1', quizMinutes: 10,
    contentId: 'c1', contentType: 'article', contentMinutes: 12,
  });

  const judgeService = require('../plan/externalContentJudgeService');
  const origJudge = judgeService.judgeTopic;
  judgeService.judgeTopic = async () => ({
    inAppCoverageAdequate: false,
    gaps: ['advanced patterns'],
    externalLinks: [
      { url: 'https://ocw.mit.edu/courses/x', title: 'MIT OCW: X', source: 'mit', why: 'patterns deep dive', estimatedMinutes: 45 },
    ],
  });

  try {
    const out = await planService.generate({
      userId: new mongoose.Types.ObjectId(),
      objectiveId: new mongoose.Types.ObjectId(),
      diagnosticAttemptId: new mongoose.Types.ObjectId(),
      objectiveType: 'upskilling',
      specificsCanonical: { targetSkill: 'react' },
      timeline: 2, weeklyCommitHours: 5,
      topicResults: [{ canonicalName: 'react-hooks', selfRating: 'familiar', measuredScore: 50, measuredBand: 'developing', calibrationDelta: 0, calibrationClass: 'well-calibrated', questionsAsked: 4, answerPattern: {}, isFutureProofing: false }],
    });
    const w0 = out.weeklySchedule[0];
    const externalLinkTasks = w0.tasks.filter(t => t.type === 'external_link');
    assert.strictEqual(externalLinkTasks.length, 1);
    assert.strictEqual(externalLinkTasks[0].payload.url, 'https://ocw.mit.edu/courses/x');
    assert.strictEqual(externalLinkTasks[0].completion.mode, 'manual');
    assert.strictEqual(externalLinkTasks[0].completion.requiresSelfRating, true);
  } finally {
    openai.chat.completions.create = origCreate;
    taskCatalogService.resolveTopic = origResolve;
    judgeService.judgeTopic = origJudge;
    delete process.env.FEATURE_EXTERNAL_CONTENT_JUDGE;
  }
});

test('generate: emits NO external_link tasks when feature flag is off (default)', async () => {
  delete process.env.FEATURE_EXTERNAL_CONTENT_JUDGE;
  const planService = require('./planGenerationService');
  const mongoose = require('mongoose');

  const openai = require('../../config/openai');
  const origCreate = openai.chat.completions.create;
  openai.chat.completions.create = async () => { throw new Error('test stub'); };

  const taskCatalogService = require('../plan/taskCatalogService');
  const origResolve = taskCatalogService.resolveTopic;
  taskCatalogService.resolveTopic = async () => ({ quizId: 'qz1', contentId: 'c1', contentType: 'article', quizMinutes: 8, contentMinutes: 12 });

  const judgeService = require('../plan/externalContentJudgeService');
  const origJudge = judgeService.judgeTopic;
  let judgeCalls = 0;
  judgeService.judgeTopic = async () => { judgeCalls++; return { inAppCoverageAdequate: false, gaps: [], externalLinks: [{ url: 'https://ocw.mit.edu/x', title: 't', source: 's', why: 'w', estimatedMinutes: 30 }] }; };

  try {
    const out = await planService.generate({
      userId: new mongoose.Types.ObjectId(),
      objectiveId: new mongoose.Types.ObjectId(),
      diagnosticAttemptId: new mongoose.Types.ObjectId(),
      objectiveType: 'upskilling',
      specificsCanonical: { targetSkill: 'react' },
      timeline: 1, weeklyCommitHours: 5,
      topicResults: [{ canonicalName: 'react-hooks', selfRating: 'familiar', measuredScore: 50, measuredBand: 'developing', calibrationDelta: 0, calibrationClass: 'well-calibrated', questionsAsked: 4, answerPattern: {}, isFutureProofing: false }],
    });
    const w0 = out.weeklySchedule[0];
    assert.strictEqual(w0.tasks.filter(t => t.type === 'external_link').length, 0);
    assert.strictEqual(judgeCalls, 0, 'judge must not be called when feature flag is off');
  } finally {
    openai.chat.completions.create = origCreate;
    taskCatalogService.resolveTopic = origResolve;
    judgeService.judgeTopic = origJudge;
  }
});
