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
const anthropic = require('../../config/anthropic');

// LLM config — Compass uses Claude Sonnet 4 to match aiProvider.js
const COMPASS_MODEL = 'claude-sonnet-4-20250514';
const COMPASS_MAX_TOKENS = 800;       // conversational replies stay tight
const COMPASS_TEMPERATURE = 0.6;

/**
 * Per-user daily token budget. Hard cap to protect AI cost per active user.
 * Free tier: 50k tokens/day. Pro tier: 200k tokens/day (TODO: wire to subscription).
 */
const DAILY_TOKEN_CAP_FREE = 50_000;
const _tokenBudgets = new Map();  // userId → { date, tokensUsed }

function checkAndIncrementBudget(userId, estimatedTokens) {
  const today = new Date().toISOString().split('T')[0];
  const entry = _tokenBudgets.get(userId);
  const used = (entry && entry.date === today) ? entry.tokensUsed : 0;
  if (used + estimatedTokens > DAILY_TOKEN_CAP_FREE) {
    return false;
  }
  _tokenBudgets.set(userId, { date: today, tokensUsed: used + estimatedTokens });
  return true;
}

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
      return await greeting({ ctx, systemPrompt, userId });

    case 'conversation':
      return await conversation({ ctx, systemPrompt, userId, message: payload.message, history: payload.history });

    case 'quiz_config':
      return quizConfig({ ctx, payload });

    case 'interview_config':
      return interviewConfig({ ctx, payload });

    case 'note':
      return { mode, output: { reply: 'Upload a PDF, image, or audio file. I\'ll process it into a summary, mind map, flashcards, and audio narration.', delegateTo: 'POST /api/v1/notes/request-upload' } };

    case 'insight':
      return await insight({ ctx, systemPrompt, userId });

    case 'mentor':
      return await conversation({
        ctx, userId,
        systemPrompt: systemPrompt + '\n[Mode: mentor — focus on career strategy, decisions, and long-term moves.]',
        message: payload.message, history: payload.history,
      });

    case 'coach':
      return await conversation({
        ctx, userId,
        systemPrompt: systemPrompt + '\n[Mode: coach — be encouraging but honest about progress.]',
        message: payload.message, history: payload.history,
      });

    default:
      return { mode: 'unknown', error: `Unknown mode: ${mode}` };
  }
}

/**
 * Single-shot LLM call. Returns text on success, null on failure or budget exhausted.
 */
async function callLLM({ userId, systemPrompt, userPrompt, history = [], maxTokens = COMPASS_MAX_TOKENS }) {
  const estimatedTokens = Math.ceil((systemPrompt.length + userPrompt.length) / 4) + maxTokens;
  if (!checkAndIncrementBudget(userId, estimatedTokens)) {
    console.warn(`[compass] user ${userId} hit daily token cap`);
    return { text: null, capped: true };
  }

  try {
    const messages = [];
    for (const h of history.slice(-8)) {
      const role = h.role === 'assistant' ? 'assistant' : 'user';
      if (typeof h.content === 'string' && h.content.trim()) {
        messages.push({ role, content: h.content });
      }
    }
    messages.push({ role: 'user', content: userPrompt });

    const response = await anthropic.messages.create({
      model: COMPASS_MODEL,
      max_tokens: maxTokens,
      temperature: COMPASS_TEMPERATURE,
      system: systemPrompt,
      messages,
    });

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    return { text: text || null, capped: false };
  } catch (err) {
    console.error('[compass] LLM error', err.message);
    return { text: null, capped: false, error: err.message };
  }
}

async function greeting({ ctx, systemPrompt, userId }) {
  const name = ctx.user?.name || 'there';

  // Use LLM for a context-aware greeting so it reflects the user's state
  // (no objective yet, plan brewing, behind/ahead of plan, etc.)
  const userPrompt = `Greet the learner in ONE short sentence (max 20 words). Don't list options — those appear as chips below your message. Make it warm, specific to their state, and prompt them to act.`;
  const { text } = await callLLM({
    userId, systemPrompt, userPrompt,
    maxTokens: 80,
  });

  // Fallback: deterministic greeting if LLM unavailable or capped
  const fallback = !ctx.objective
    ? `Hi ${name} — let's set up your goal first.`
    : !ctx.plan
      ? `Hi ${name} — your plan is brewing. Want to chat or browse content while we wait?`
      : `Hi ${name} — what do you want to do?`;

  return {
    mode: 'greeting',
    output: {
      message: text || fallback,
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

async function conversation({ ctx, systemPrompt, userId, message, history = [] }) {
  if (!message || typeof message !== 'string') {
    return { mode: 'conversation', output: { reply: 'Tell me what you need.', followups: [] } };
  }

  // Append a directive to keep replies tight + offer follow-ups inline
  const extended = systemPrompt + `\n\nReply rules:\n- Be conversational and concise (3-5 sentences max unless the question genuinely requires more).\n- Ground answers in the learner's objective and recent context.\n- End with up to 3 short follow-up suggestions as a JSON code block: \`\`\`json\n{"followups":["…","…","…"]}\n\`\`\` — these will be parsed and shown as chips.\n- Refuse off-topic / harmful / professional-advice requests politely; redirect to learning.`;

  const { text, capped } = await callLLM({
    userId, systemPrompt: extended, userPrompt: message, history,
    maxTokens: COMPASS_MAX_TOKENS,
  });

  if (capped) {
    return {
      mode: 'conversation',
      output: {
        reply: "You've hit today's free Compass usage. Try again tomorrow or upgrade for higher limits.",
        followups: [],
      },
    };
  }

  if (!text) {
    return {
      mode: 'conversation',
      output: {
        reply: "I had trouble thinking that through just now. Try again in a moment?",
        followups: ['Retry', 'Try something else'],
      },
    };
  }

  // Strip the JSON followups block out of the visible reply and parse it.
  let reply = text;
  let followups = [];
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (Array.isArray(parsed.followups)) followups = parsed.followups.slice(0, 3);
    } catch (_) {}
    reply = text.replace(jsonMatch[0], '').trim();
  }

  return { mode: 'conversation', output: { reply, followups } };
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

async function insight({ ctx, systemPrompt, userId }) {
  if (!ctx.plan) {
    return { mode: 'insight', output: { headline: 'Plan not yet generated.', items: [] } };
  }

  // Compute heuristic signals first — these are deterministic guardrails.
  const signals = [];
  if (ctx.plan.tasksDoneThisWeek < ctx.plan.tasksTotalThisWeek / 2) {
    signals.push({ severity: 'warn', topic: 'plan_progress', detail: `${ctx.plan.tasksDoneThisWeek}/${ctx.plan.tasksTotalThisWeek} tasks done this week.` });
  }
  if (ctx.knowledge.weakTopics[0]) {
    const w = ctx.knowledge.weakTopics[0];
    signals.push({ severity: 'info', topic: w.topic, detail: `Mastery ${w.mastery}%.` });
  }
  if (signals.length === 0) {
    signals.push({ severity: 'good', topic: 'on_track', detail: 'On pace this week.' });
  }

  // Ask LLM to phrase the insights warmly and propose 1 concrete next action per signal.
  const userPrompt = `Given these signals about the learner, write 1-3 short observations in the user's voice (second-person, warm, honest). Return STRICT JSON only:\n{ "headline": "Here's what I noticed.", "items": [ { "severity": "warn|info|good", "text": "..." } ] }\n\nSignals: ${JSON.stringify(signals)}`;

  const { text } = await callLLM({
    userId,
    systemPrompt,
    userPrompt,
    maxTokens: 400,
  });

  if (text) {
    try {
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || text);
      if (parsed && Array.isArray(parsed.items)) {
        return { mode: 'insight', output: parsed };
      }
    } catch (_) { /* fall through to deterministic */ }
  }

  // Deterministic fallback — never lets the screen fail to render.
  const fallbackItems = signals.map(s => ({
    severity: s.severity,
    text: s.severity === 'warn'
      ? `You're behind on this week — ${s.detail}`
      : s.severity === 'info'
        ? `Your weakest topic is ${s.topic}. ${s.detail}`
        : `You're on track. Keep going.`,
  }));
  return { mode: 'insight', output: { headline: 'Here\'s what I noticed.', items: fallbackItems } };
}

module.exports = {
  handle,
  buildUserContext,
  buildSystemContext,
};
