/**
 * Compass Orchestrator (v2)
 *
 * The single AI entry that consolidates v1's 11 fragmented features:
 *   - AI Tutor (in player)
 *   - Quiz generation
 *   - Flashcard generation
 *   - Mind map generation
 *   - Audio summary generation
 *   - Interview evaluation
 *   - Diagnostic insights
 *   - OCR
 *   - Conversational chat
 *
 * One entry point. Mode-routed. Always carries full user context.
 *
 * User context = objective + plan progress + recent content + recent quiz performance
 *                + recent conversations + behavioral signals.
 *
 * Modes:
 *   - tutor         (in-content explanation)
 *   - conversation  (free-form on topic)
 *   - quiz_config   (configurator for quiz)
 *   - interview_config
 *   - note          (process uploaded material)
 *   - insight       (proactive — "here's what I noticed")
 *   - mentor        (career strategy)
 *   - coach         (encouragement / reality check)
 *
 * This file is the dispatcher. Heavy lifting is delegated to existing v1 services
 * (quizGenerationService, aiTutorService, etc.) — Compass just gives them a
 * consistent context envelope and a unified response shape.
 */

const User = require('../../models/User');
const UserObjective = require('../../models/UserObjective');
const KnowledgeProfile = require('../../models/KnowledgeProfile');
const Plan = require('../../models/Plan');
const Conversation = require('../../models/Conversation');

/**
 * Build the user context envelope. Every Compass call uses this.
 * Cached for the duration of a single request — fetched fresh per request.
 */
async function buildUserContext(userId) {
  const [user, objective, plan, knowledge] = await Promise.all([
    User.findById(userId).select('firstName education workExperience').lean(),
    UserObjective.findOne({ userId, status: 'active', isPrimary: true }).lean(),
    Plan.findOne({ userId, status: { $in: ['active', 'ready'] } }).lean(),
    KnowledgeProfile.findOne({ userId }).lean(),
  ]);

  const topicMastery = knowledge?.topicProfiles
    ? Object.entries(knowledge.topicProfiles)
        .map(([topic, t]) => ({ topic, mastery: t.masteryLevel || 0, trend: t.trend || 'flat' }))
        .sort((a, b) => b.mastery - a.mastery)
    : [];

  return {
    user: {
      name: user?.firstName || 'there',
    },
    objective: objective ? {
      type: objective.objectiveType,
      specifics: objective.specifics,
      timeline: objective.timeline,
      targetDate: objective.targetDate,
      currentLevel: objective.currentLevel,
    } : null,
    plan: plan ? {
      currentWeek: plan.currentWeek,
      totalWeeks: plan.totalWeeks,
      readiness: plan.readinessScore,
      tasksDoneThisWeek: (plan.tasks || []).filter(t => t.weekNumber === plan.currentWeek && t.completedAt).length,
      tasksTotalThisWeek: (plan.tasks || []).filter(t => t.weekNumber === plan.currentWeek).length,
    } : null,
    knowledge: {
      strongTopics: topicMastery.slice(0, 3),
      weakTopics:   topicMastery.slice(-3).reverse(),
    },
  };
}

/**
 * Build a system prompt block from user context.
 * Inject this into every LLM call across Compass modes.
 */
function buildSystemContext(ctx) {
  const lines = [];
  lines.push(`You are Compass, ScaleUp's AI companion. Be concise, warm, honest.`);
  lines.push(`Identify as AI when asked. Refuse off-topic / harmful / professional-advice requests; redirect to learning.`);
  if (ctx.user?.name) lines.push(`The learner's name is ${ctx.user.name}.`);
  if (ctx.objective) {
    lines.push(`Their active objective: ${ctx.objective.type} — ${JSON.stringify(ctx.objective.specifics)}, timeline ${ctx.objective.timeline}, currently ${ctx.objective.currentLevel}.`);
  }
  if (ctx.plan) {
    lines.push(`Plan progress: week ${ctx.plan.currentWeek}/${ctx.plan.totalWeeks}, readiness ${ctx.plan.readiness}%, ${ctx.plan.tasksDoneThisWeek}/${ctx.plan.tasksTotalThisWeek} tasks done this week.`);
  }
  if (ctx.knowledge.strongTopics.length) {
    lines.push(`Strong topics: ${ctx.knowledge.strongTopics.map(t => `${t.topic} (${t.mastery}%)`).join(', ')}`);
  }
  if (ctx.knowledge.weakTopics.length) {
    lines.push(`Weak topics: ${ctx.knowledge.weakTopics.map(t => `${t.topic} (${t.mastery}%)`).join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * Dispatch a Compass request by mode.
 *
 * @param {Object} args
 * @param {String} args.userId
 * @param {String} args.mode    - tutor | conversation | quiz_config | interview_config | note | insight | mentor | coach
 * @param {Object} args.payload - mode-specific input
 *
 * @returns {Object} mode-specific response shape, but always with:
 *   { mode, context: { hasObjective, hasPlan, ... }, output: {...} }
 */
async function handle({ userId, mode, payload = {} }) {
  const ctx = await buildUserContext(userId);
  const systemPrompt = buildSystemContext(ctx);

  switch (mode) {
    case 'greeting':
      return greeting(ctx);

    case 'conversation':
      return await conversation({ ctx, systemPrompt, message: payload.message, history: payload.history });

    case 'quiz_config':
      return quizConfig({ ctx, payload });

    case 'interview_config':
      return interviewConfig({ ctx, payload });

    case 'note':
      // Stub — delegates to existing notes processing pipeline
      return { mode, output: { ack: 'Forwarding to notes pipeline.', delegateTo: 'POST /api/v1/notes/request-upload' } };

    case 'insight':
      return insight(ctx);

    case 'mentor':
      return await conversation({ ctx, systemPrompt: systemPrompt + '\n[Mode: mentor — focus on career strategy.]', message: payload.message, history: payload.history });

    case 'coach':
      return await conversation({ ctx, systemPrompt: systemPrompt + '\n[Mode: coach — be encouraging but honest about progress.]', message: payload.message, history: payload.history });

    default:
      return { mode: 'unknown', error: `Unknown mode: ${mode}` };
  }
}

function greeting(ctx) {
  const name = ctx.user?.name || 'there';
  let msg;
  if (!ctx.objective) {
    msg = `Hi ${name} — let's set up your goal first.`;
  } else if (!ctx.plan) {
    msg = `Hi ${name} — your plan is being built. Want to chat or explore content while it's brewing?`;
  } else {
    msg = `Hi ${name} — what do you want to do?`;
  }
  return {
    mode: 'greeting',
    output: {
      message: msg,
      suggestedActions: [
        { id: 'quiz_me',       label: '⚡ Quiz me',           mode: 'quiz_config' },
        { id: 'interview',     label: '🎙️ Practice interview', mode: 'interview_config' },
        { id: 'note',          label: '📝 Make a note',       mode: 'note' },
        { id: 'plan_next',     label: '↗ Plan my next 2 days', mode: 'conversation' },
        { id: 'explain',       label: '🤔 Explain something',  mode: 'conversation' },
      ],
    },
  };
}

async function conversation({ ctx, systemPrompt, message, history = [] }) {
  // In real impl, delegate to existing aiTutorService or a generic LLM call.
  // Returning a deterministic stub so iOS can integrate against a stable shape
  // and the LLM wiring can be plugged behind this without iOS churn.
  return {
    mode: 'conversation',
    output: {
      reply: `[Compass placeholder reply with full context: ${ctx.objective?.type || 'no objective'}, weak topics: ${ctx.knowledge.weakTopics.map(t => t.topic).join(', ') || 'none'}]\n\nYou said: "${message}"`,
      followups: [
        'Tell me more about that',
        'Quiz me on this',
        'Move on to something else',
      ],
    },
  };
}

function quizConfig({ ctx }) {
  // Surfaces the inline configurator state for the iOS Compass chat to render.
  const weakest = ctx.knowledge.weakTopics[0];
  return {
    mode: 'quiz_config',
    output: {
      headline: 'Got it. Here\'s how I\'d set it up — change anything you want.',
      config: {
        topic:      { value: weakest ? weakest.topic : 'last 7 days', label: weakest ? `Focused: ${weakest.topic}` : 'Last 7 days of content' },
        format:     { value: 'mix',    label: 'Mix · recall + application' },
        difficulty: { value: 'medium', label: 'Medium · adaptive' },
        count:      { value: 10,       label: '10 questions' },
        tagToObjective: { value: true, label: 'Count toward readiness' },
      },
      estimateMin: 8,
      startEndpoint: '/api/v1/quizzes/request', // routes into existing v1 quiz path
    },
  };
}

function interviewConfig({ ctx }) {
  const targetRole = ctx.objective?.specifics?.targetRole || 'general role';
  return {
    mode: 'interview_config',
    output: {
      headline: 'Mock interview — adjust if needed.',
      config: {
        type:        { value: 'behavioral', label: 'Behavioral' },
        targetRole:  { value: targetRole,   label: targetRole },
        duration:    { value: 30,           label: '30 min' },
        seniority:   { value: 'mid',        label: 'Mid-level' },
        tagToObjective: { value: true, label: 'Count toward readiness' },
      },
      startEndpoint: '/api/v1/interviews/start',
    },
  };
}

function insight(ctx) {
  if (!ctx.plan) {
    return { mode: 'insight', output: { headline: 'Plan not yet generated.', items: [] } };
  }
  const items = [];
  if (ctx.plan.tasksDoneThisWeek < ctx.plan.tasksTotalThisWeek / 2) {
    items.push({ severity: 'warn', text: `You're behind on this week's plan — ${ctx.plan.tasksDoneThisWeek}/${ctx.plan.tasksTotalThisWeek} done.` });
  }
  if (ctx.knowledge.weakTopics[0]) {
    const w = ctx.knowledge.weakTopics[0];
    items.push({ severity: 'info', text: `Your weakest topic is ${w.topic} at ${w.mastery}%. Want a deep-dive?` });
  }
  if (items.length === 0) {
    items.push({ severity: 'good', text: 'You\'re on track. Keep going.' });
  }
  return { mode: 'insight', output: { headline: 'Here\'s what I noticed.', items } };
}

module.exports = {
  handle,
  buildUserContext,
  buildSystemContext,
};
