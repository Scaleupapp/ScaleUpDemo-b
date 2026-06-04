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
 *   - coach         (general-purpose retrospective + reflection — scoped by
 *                    the caller to a window (week | month | all_time | topic).
 *                    Replaces the old `review_week` mode; `review_week` still
 *                    accepted as an alias that maps to scope='week' for
 *                    back-compat with older iOS builds.)
 *   - coder         (AI pair-programmer inside coding drills / Capstone — lives
 *                    in src/coding/services/compassCoder.js, NOT in this file.
 *                    Uses the coding llmRouter (taskId: 'compass_coder') and has
 *                    its own system prompt emphasising specificity + pushback.
 *                    Coding-feature routes call compassCoder.chat() directly.)
 *
 * This file is the dispatcher. Heavy lifting is delegated to existing v1 services
 * (quizGenerationService, aiTutorService, etc.) — Compass just gives them a
 * consistent context envelope and a unified response shape.
 */

const User = require('../../models/User');
const UserObjective = require('../../models/UserObjective');
const KnowledgeProfile = require('../../models/KnowledgeProfile');
const Plan = require('../../models/Plan');
const CompassConversation = require('../../models/CompassConversation');
const anthropic = require('../../config/anthropic');
const redis = require('../../config/redis');
const userContextService = require('../userContextService');
const readinessService = require('../readiness/readinessService');
const compassTools = require('./compassTools');
const compassProgress = require('./compassProgressService');
const { detectDrillRequest } = require('./compassIntent');
const { detectTutoringRequest } = require('./tutoringIntent');

const COMPASS_MAX_TOOL_ITERATIONS = 5;

// Persistence: max age of the "active" thread before a new one starts.
const ACTIVE_THREAD_MAX_AGE_MIN = 60 * 12;  // 12 hours

/**
 * Get the user's active Compass thread, or create a new one.
 * Threads roll over after a long inactivity window so the context window stays bounded.
 */
async function getOrCreateActiveThread(userId) {
  if (!userId) return null;
  const cutoff = new Date(Date.now() - ACTIVE_THREAD_MAX_AGE_MIN * 60 * 1000);
  let thread = await CompassConversation.findOne({
    userId, isArchived: false, lastMessageAt: { $gte: cutoff },
  }).sort({ lastMessageAt: -1 });
  if (!thread) {
    thread = await CompassConversation.create({ userId });
  }
  return thread;
}

/**
 * Append a message to the active thread. Best-effort — DB errors do not fail the LLM call.
 */
async function appendToThread(userId, role, content, opts = {}) {
  try {
    const thread = await getOrCreateActiveThread(userId);
    if (!thread) return;
    thread.messages.push({
      role,
      content: typeof content === 'string' ? content.slice(0, 8000) : '',
      mode: opts.mode,
      followups: opts.followups || [],
      cards: opts.cards || [],
      contentRef: opts.contentRef,
      contentTitle: opts.contentTitle,
      tokensIn: opts.tokensIn,
      tokensOut: opts.tokensOut,
    });
    thread.messageCount = thread.messages.length;
    thread.lastMessageAt = new Date();
    if (!thread.title || thread.title === 'New conversation') {
      // Auto-title from the first user message
      if (role === 'user' && content) {
        thread.title = content.slice(0, 60);
      }
    }
    await thread.save();
  } catch (err) {
    console.warn('[compass] failed to persist message', err.message);
  }
}

// LLM config — Compass uses Claude Sonnet 4 to match aiProvider.js
const COMPASS_MODEL = 'claude-sonnet-4-20250514';
const COMPASS_MAX_TOKENS = 800;       // conversational replies stay tight
const COMPASS_TEMPERATURE = 0.6;

/**
 * Per-user daily token budget. Hard cap to protect AI cost per active user.
 * Free tier: 50k tokens/day. Pro tier: 200k tokens/day (TODO: wire to subscription).
 *
 * Redis-backed so caps survive server restarts and are consistent across
 * horizontally-scaled workers. Keys auto-expire at end of day.
 */
const DAILY_TOKEN_CAP_FREE = 50_000;
const DAILY_TOKEN_CAP_PRO  = 200_000;

function budgetKey(userId) {
  const today = new Date().toISOString().split('T')[0];
  return `compass:budget:${userId}:${today}`;
}

function secondsUntilEndOfDayUTC() {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return Math.max(60, Math.ceil((tomorrow - now) / 1000));
}

/**
 * Atomically increment the user's daily token usage in Redis. If the new total
 * would exceed the cap, decrement back and return false (caller should refuse
 * the LLM call). Auto-expires the key at midnight UTC.
 *
 * Falls open on Redis errors so a Redis outage doesn't break Compass.
 */
async function checkAndIncrementBudget(userId, estimatedTokens, cap = DAILY_TOKEN_CAP_FREE) {
  if (!userId || !estimatedTokens || estimatedTokens <= 0) return true;
  try {
    const key = budgetKey(userId);
    const newTotal = await redis.incrby(key, estimatedTokens);
    if (newTotal === estimatedTokens) {
      // First write today — set expiry so the counter rolls over at midnight UTC
      await redis.expire(key, secondsUntilEndOfDayUTC());
    }
    if (newTotal > cap) {
      // Over-budget: refund the increment we just made so subsequent shorter
      // requests can still squeak through if the cap is at the edge.
      await redis.decrby(key, estimatedTokens);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[compass] Redis budget check failed, falling open:', err.message);
    return true;
  }
}

/**
 * Best-effort current usage report (for diagnostics / future Pro upgrade prompt).
 */
async function getBudgetUsage(userId) {
  try {
    const used = parseInt(await redis.get(budgetKey(userId)) || '0', 10);
    return { used, cap: DAILY_TOKEN_CAP_FREE };
  } catch (_) {
    return { used: 0, cap: DAILY_TOKEN_CAP_FREE };
  }
}

/**
 * Build the user context envelope. Every Compass call uses this.
 * Cached for the duration of a single request — fetched fresh per request.
 */
async function buildUserContext(userId) {
  const [user, objective, plan, knowledge, deepContext, readiness] = await Promise.all([
    User.findById(userId).select('firstName education workExperience').lean(),
    UserObjective.findOne({ userId, status: 'active', isPrimary: true }).lean(),
    Plan.findOne({ userId, isActive: true }).lean(),
    KnowledgeProfile.findOne({ userId }).lean(),
    userContextService.getUserContext(userId).catch(() => null),
    readinessService.getServedReadiness(userId).catch(() => null),
  ]);

  const topicMastery = Array.isArray(knowledge?.topicMastery)
    ? knowledge.topicMastery
        .filter((t) => typeof t.score === 'number')
        .map((t) => ({ topic: t.topic, mastery: t.score, trend: t.trend || 'stable' }))
        .sort((a, b) => b.mastery - a.mastery)
    : [];

  let planCtx = null;
  if (plan) {
    const totalWeeks = (plan.weeklySchedule || []).length;
    const weeksElapsed = plan.createdAt ? Math.floor((Date.now() - new Date(plan.createdAt)) / (7 * 24 * 3600 * 1000)) + 1 : 1;
    const currentWeek = Math.min(Math.max(weeksElapsed, 1), Math.max(totalWeeks, 1));
    const wk = (plan.weeklySchedule || []).find((w) => w.week === currentWeek);
    const tasks = wk?.tasks || [];
    planCtx = {
      currentWeek, totalWeeks,
      tasksDoneThisWeek: tasks.filter((t) => t.progress?.status === 'complete' || t.progress?.completedAt).length,
      tasksTotalThisWeek: tasks.length,
    };
  }

  return {
    user: { name: user?.firstName || 'there' },
    objective: objective ? {
      type: objective.objectiveType, specifics: objective.specifics,
      timeline: objective.timeline, targetDate: objective.targetDate, currentLevel: objective.currentLevel,
    } : null,
    plan: planCtx,
    readiness: readiness ? { value: readiness.value, target: readiness.target, source: readiness.source } : null,
    knowledge: { strongTopics: topicMastery.slice(0, 3), weakTopics: topicMastery.slice(-3).reverse() },
    deep: deepContext ? {
      misconceptions: (deepContext.misconceptions || []).slice(0, 3),
      dueForReview: (deepContext.dueForReview || []).slice(0, 3),
      recentTopics: (deepContext.recentTopicsTouched || []).slice(0, 5),
      recentTutor: (deepContext.recentAITutor?.topicsCovered || []).slice(0, 3),
      lastTutorQs: (deepContext.recentAITutor?.openQuestions || []).slice(0, 2),
    } : null,
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
    lines.push(`Plan progress: week ${ctx.plan.currentWeek}/${ctx.plan.totalWeeks}, ${ctx.plan.tasksDoneThisWeek}/${ctx.plan.tasksTotalThisWeek} tasks done this week.`);
  }
  if (ctx.readiness) {
    lines.push(`Current readiness: ${ctx.readiness.value}% (target ${ctx.readiness.target}%).`);
  }
  if (ctx.knowledge.strongTopics.length) {
    lines.push(`Strong topics: ${ctx.knowledge.strongTopics.map(t => `${t.topic} (${t.mastery}%)`).join(', ')}`);
  }
  if (ctx.knowledge.weakTopics.length) {
    lines.push(`Weak topics: ${ctx.knowledge.weakTopics.map(t => `${t.topic} (${t.mastery}%)`).join(', ')}`);
  }
  // Cross-context signals — what the user recently struggled with, what's
  // overdue for review, what they asked the tutor. Makes the AI feel like it
  // remembers them instead of starting from zero every turn.
  if (ctx.deep) {
    if (ctx.deep.recentTopics?.length) {
      lines.push(`Recently practiced/quizzed on: ${ctx.deep.recentTopics.join(', ')}.`);
    }
    if (ctx.deep.misconceptions?.length) {
      lines.push(`Known recurring misconceptions: ${ctx.deep.misconceptions.map(m => `${m.tag} (${m.explanation})`).join('; ')}.`);
    }
    if (ctx.deep.dueForReview?.length) {
      lines.push(`Overdue for spaced review: ${ctx.deep.dueForReview.map(d => d.concept).join(', ')}.`);
    }
    if (ctx.deep.recentTutor?.length) {
      lines.push(`Recently asked the tutor about: ${ctx.deep.recentTutor.join(', ')}.`);
    }
    if (ctx.deep.lastTutorQs?.length) {
      const qs = ctx.deep.lastTutorQs.map(q => `"${q.question}"`).join(' / ');
      lines.push(`Recent tutor questions still open: ${qs}.`);
    }
    lines.push(`Use this context to make responses feel personal — don't ask the learner to repeat what we already know.`);
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

  let response;

  switch (mode) {
    case 'greeting':
      response = await greeting({ ctx, systemPrompt, userId, contextHint: payload.message });
      break;

    case 'conversation':
      response = await conversation({ ctx, systemPrompt, userId, message: payload.message, history: payload.history });
      break;

    case 'tutor':
      // The merged AI Tutor — Compass scoped to a specific piece of content.
      // Same brain, same unified history (CompassConversation), but the prompt
      // is grounded in the video/article and the turn is tagged with contentRef.
      response = await tutor({ ctx, systemPrompt, userId, contentId: payload.contentId, message: payload.message, history: payload.history });
      break;

    case 'quiz_config':
      response = quizConfig({ ctx, payload });
      break;

    case 'interview_config':
      response = interviewConfig({ ctx, payload });
      break;

    case 'note': {
      // Note mode: tells the iOS client to launch the v1 upload flow.
      // We don't directly proxy the multipart upload from Compass — the client
      // hits /api/v1/notes/request-upload to get a presigned S3 URL, then
      // uploads, then completes. We persist the user intent into the thread.
      const reply = "I can turn an upload into a summary, mind map, flashcards, and audio narration. Choose a file (PDF, image, or audio) to get started.";
      await appendToThread(userId, 'assistant', reply, { mode: 'note' });
      response = {
        mode: 'note',
        output: {
          reply,
          action: {
            type: 'open_note_upload',
            // iOS observes `action.type` and presents its v1 CreateNotesView /
            // file picker. Provide the API endpoints so the iOS client doesn't
            // need to hard-code them.
            endpoints: {
              requestUpload: 'POST /api/v1/notes/request-upload',
              completeUpload: 'POST /api/v1/notes/complete-upload',
            },
          },
        },
      };
      break;
    }

    case 'insight':
      response = await insight({ ctx, systemPrompt, userId });
      break;

    case 'mentor':
      response = await conversation({
        ctx, userId,
        systemPrompt: systemPrompt + '\n[Mode: mentor — focus on career strategy, decisions, and long-term moves.]',
        message: payload.message, history: payload.history,
      });
      break;

    case 'coach':
    case 'review_week': {
      // Back-compat: `review_week` is an alias for `coach` with scope='week'.
      // Older iOS builds (TestFlight 151 and earlier) still send `review_week`.
      const scope = normalizeScope(payload.scope) || (mode === 'review_week' ? 'week' : 'week');
      const topic = typeof payload.topic === 'string' ? payload.topic.trim() : null;
      // First turn: synthesize the retrospective opening. Subsequent turns
      // (when the client passes a `message`) flow through conversation with
      // the coach framing pinned to the system prompt.
      if (payload.message) {
        response = await conversation({
          ctx, userId,
          systemPrompt: systemPrompt + `\n[Mode: coach — ${coachFramingForScope(scope, topic)} Help the learner reflect and commit to a concrete next move.]`,
          message: payload.message, history: payload.history,
        });
      } else {
        response = await coachOpener({ ctx, systemPrompt, userId, scope, topic, weekNumber: payload.weekNumber });
      }
      break;
    }

    case 'tutor_topic':
      response = await tutorTopic({ systemPrompt, userId, topic: payload.topic });
      break;

    case 'tutor_result':
      response = await tutorResult({ systemPrompt, userId, topic: payload.topic, attemptId: payload.attemptId, beforeScore: payload.beforeScore });
      break;

    default:
      return { mode: 'unknown', error: `Unknown mode: ${mode}` };
  }

  // ---------------------------------------------------------------------------
  // Intent detection — run on user messages in conversational modes.
  // Appends suggested_action when a drill request is detected. Best-effort:
  // never throws, never delays the response on failure.
  // Only fires for modes where the user is typing a free-form message.
  // ---------------------------------------------------------------------------
  const INTENT_ELIGIBLE_MODES = ['conversation', 'tutor', 'mentor', 'coach', 'review_week'];
  const userMessage = payload && payload.message;
  if (
    INTENT_ELIGIBLE_MODES.includes(mode) && userMessage &&
    response && response.output && !response.output.suggested_action
  ) {
    try {
      const tutoring = await detectTutoringRequest(userMessage);
      if (tutoring) {
        response.output.suggested_action = tutoring;
      } else {
        const action = await detectDrillRequest(userMessage);
        if (action) response.output.suggested_action = action;
      }
    } catch (e) {
      console.error('[compass intent detection]', e.message);
    }
  }

  // Proactive tutoring offer: if a turn surfaced weak topics and nothing else
  // claimed the action slot, offer to tutor the top weak topic.
  attachProactiveTutoringOffer(response);

  return response;
}

/**
 * Single-shot LLM call. Returns text on success, null on failure or budget exhausted.
 */
async function callLLM({ userId, systemPrompt, userPrompt, history = [], maxTokens = COMPASS_MAX_TOKENS }) {
  // Estimate first — Anthropic charges by total tokens; we approximate at 4 chars/token.
  const estimatedTokens = Math.ceil((systemPrompt.length + userPrompt.length) / 4) + maxTokens;
  const allowed = await checkAndIncrementBudget(userId, estimatedTokens);
  if (!allowed) {
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

    // Reconcile: deduct the estimate, then charge actual usage.
    // Anthropic returns response.usage = { input_tokens, output_tokens }.
    const actualTokens = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);
    const delta = actualTokens - estimatedTokens;
    if (delta !== 0) {
      // delta > 0 → actual exceeded estimate; charge the difference.
      // delta < 0 → estimate was too high; refund.
      await adjustBudget(userId, delta);
    }

    return {
      text: text || null,
      capped: false,
      tokensIn: response.usage?.input_tokens || 0,
      tokensOut: response.usage?.output_tokens || 0,
    };
  } catch (err) {
    // Refund the estimate since the call didn't actually consume tokens.
    await adjustBudget(userId, -estimatedTokens);
    console.error('[compass] LLM error', err.message);
    return { text: null, capped: false, error: err.message };
  }
}

/**
 * Adjust today's budget counter by `delta` (positive = charge more, negative = refund).
 * Used for actual-vs-estimate reconciliation.
 */
async function adjustBudget(userId, delta) {
  if (!userId || delta === 0) return;
  try {
    const key = budgetKey(userId);
    await redis.incrby(key, delta);
  } catch (err) {
    console.warn('[compass] Redis budget adjust failed:', err.message);
  }
}

/**
 * Tool-enabled LLM call. Mirrors compassCoder.turn(): loop calling the model
 * with read-only Compass tools; on stop_reason='tool_use', dispatch each tool,
 * feed results back, repeat (capped at COMPASS_MAX_TOOL_ITERATIONS). Collects
 * the cards emitted by invoked tools (deduped by type, capped at 2).
 */
async function callLLMWithTools({ userId, systemPrompt, userPrompt, history = [], maxTokens = COMPASS_MAX_TOKENS }) {
  // Tool loops burn more than a single chat turn — reserve 2x maxTokens headroom.
  const estimatedTokens = Math.ceil((systemPrompt.length + userPrompt.length) / 4) + maxTokens * 2;
  const allowed = await checkAndIncrementBudget(userId, estimatedTokens);
  if (!allowed) {
    console.warn(`[compass] user ${userId} hit daily token cap (tools)`);
    return { text: null, cards: [], capped: true };
  }

  const messages = [];
  for (const h of history.slice(-8)) {
    const role = h.role === 'assistant' ? 'assistant' : 'user';
    if (typeof h.content === 'string' && h.content.trim()) messages.push({ role, content: h.content });
  }
  messages.push({ role: 'user', content: userPrompt });

  const cards = [];
  let totalIn = 0;
  let totalOut = 0;
  let finalText = '';
  try {
    for (let iter = 0; iter < COMPASS_MAX_TOOL_ITERATIONS; iter++) {
      const response = await anthropic.messages.create({
        model: COMPASS_MODEL, max_tokens: maxTokens, temperature: COMPASS_TEMPERATURE,
        system: systemPrompt, messages, tools: compassTools.TOOLS,
      });
      totalIn += response.usage?.input_tokens || 0;
      totalOut += response.usage?.output_tokens || 0;
      messages.push({ role: 'assistant', content: response.content });

      const text = (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      if (text) finalText = text;
      if (response.stop_reason !== 'tool_use') break;

      const toolUses = (response.content || []).filter((b) => b.type === 'tool_use');
      const toolResults = [];
      for (const block of toolUses) {
        const r = await compassTools.dispatch({ userId, name: block.name, input: block.input });
        if (r.card) cards.push(r.card);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: r.output, is_error: !r.ok });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    const actual = totalIn + totalOut;
    await adjustBudget(userId, actual - estimatedTokens);

    const seen = new Set();
    const deduped = [];
    for (const c of cards) {
      if (seen.has(c.type)) continue;
      seen.add(c.type); deduped.push(c);
      if (deduped.length >= 2) break;
    }
    return { text: finalText || null, cards: deduped, capped: false, tokensIn: totalIn, tokensOut: totalOut };
  } catch (err) {
    await adjustBudget(userId, -estimatedTokens);
    console.error('[compass] tool-loop LLM error', err.message);
    return { text: null, cards: [], capped: false, error: err.message };
  }
}

async function greeting({ ctx, systemPrompt, userId, contextHint }) {
  const name = ctx.user?.name || 'there';

  // LLM-generated greeting, optionally adapted by the screen the user came from.
  const userPrompt = contextHint
    ? `${contextHint}\n\nGreet the learner in ONE short sentence (max 20 words) tailored to that context. Don't list options — those appear as chips below.`
    : `Greet the learner in ONE short sentence (max 20 words). Don't list options — those appear as chips below your message. Make it warm, specific to their state, and prompt them to act.`;
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

  const greetingText = text || fallback;

  // Persist greeting so conversation history is coherent across cold-starts.
  await appendToThread(userId, 'assistant', greetingText, { mode: 'greeting' });

  return {
    mode: 'greeting',
    output: {
      message: greetingText,
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
    return { mode: 'conversation', output: { reply: 'Tell me what you need.', followups: [], cards: [] } };
  }

  await appendToThread(userId, 'user', message, { mode: 'conversation' });

  let effectiveHistory = history;
  if (!history || history.length === 0) {
    try {
      const thread = await getOrCreateActiveThread(userId);
      effectiveHistory = (thread?.messages || []).slice(-8, -1).map((m) => ({ role: m.role, content: m.content }));
    } catch (_) {}
  }

  // Live progress snapshot + the hard never-invent rule + tool guidance.
  let snapshotBlock = '';
  try {
    const snap = await compassProgress.getSnapshot(userId);
    const rendered = compassProgress.renderSnapshot(snap);
    if (rendered) snapshotBlock = `\n\n--- CURRENT PROGRESS SNAPSHOT (live data) ---\n${rendered}\n--- END SNAPSHOT ---`;
  } catch (_) {}

  const extended = systemPrompt + snapshotBlock +
    `\n\nYou can call read-only tools to look up specifics (a latest result, a named activity, a topic, weak topics, the readiness breakdown, recent activity). Use them for ANY question about the learner's performance or progress.` +
    `\nNEVER state a number, score, or result you did not get from the snapshot above or from a tool. If you don't have it, call a tool — or say you'll check.` +
    `\n\nReply rules:\n- Be conversational and concise (3-5 sentences max unless the question genuinely requires more).\n- Ground answers in the learner's objective and recent context.\n- End with up to 3 short follow-up suggestions as a JSON code block: \`\`\`json\n{"followups":["…","…","…"]}\n\`\`\` — these will be parsed and shown as chips.\n- Refuse off-topic / harmful / professional-advice requests politely; redirect to learning.`;

  const llmResult = await callLLMWithTools({ userId, systemPrompt: extended, userPrompt: message, history: effectiveHistory, maxTokens: COMPASS_MAX_TOKENS });
  let { text, cards = [], capped, tokensIn, tokensOut } = llmResult;

  // Retry once WITHOUT tools (snapshot-only answer) on a tool-loop failure
  // (not on a budget cap — capped is a hard stop).
  if (!capped && !text) {
    const retry = await callLLM({ userId, systemPrompt: extended, userPrompt: message, history: effectiveHistory, maxTokens: COMPASS_MAX_TOKENS });
    if (retry.text) { text = retry.text; cards = []; tokensIn = retry.tokensIn; tokensOut = retry.tokensOut; }
    else if (retry.capped) { capped = true; }
  }

  if (capped) {
    const reply = "You've hit today's free Compass usage. Try again tomorrow or upgrade for higher limits.";
    await appendToThread(userId, 'assistant', reply, { mode: 'conversation' });
    return { mode: 'conversation', output: { reply, followups: [], cards: [] } };
  }

  if (!text) {
    const reply = 'I had trouble thinking that through just now. Try again in a moment?';
    await appendToThread(userId, 'assistant', reply, { mode: 'conversation', followups: ['Retry', 'Try something else'] });
    return { mode: 'conversation', output: { reply, followups: ['Retry', 'Try something else'], cards: [] } };
  }

  let reply = text;
  let followups = [];
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (jsonMatch) {
    try { const parsed = JSON.parse(jsonMatch[1]); if (Array.isArray(parsed.followups)) followups = parsed.followups.slice(0, 3); } catch (_) {}
    reply = text.replace(jsonMatch[0], '').trim();
  }

  await appendToThread(userId, 'assistant', reply, { mode: 'conversation', followups, cards, tokensIn, tokensOut });
  return { mode: 'conversation', output: { reply, followups, cards } };
}

/**
 * Tutor mode — the merged AI Tutor. Same Compass brain + same unified history,
 * but the prompt is GROUNDED in a specific piece of content and the turn is
 * tagged with contentRef so:
 *   - the iOS history shows "Tutor · <video title>"
 *   - analytics can attribute tutor usage to content + feed recommendations
 *   - the learner's full objective/plan context still informs the answer
 *
 * Replaces v1's standalone aiTutorService for v2 users — one AI surface.
 */
async function tutor({ ctx, systemPrompt, userId, contentId, message, history = [] }) {
  if (!message || typeof message !== 'string') {
    return { mode: 'tutor', output: { reply: 'Ask me anything about this lesson.', followups: [] } };
  }

  // Load the content this tutor turn is scoped to.
  let content = null;
  try {
    const Content = require('../../models/Content');
    content = await Content.findById(contentId)
      .select('title description transcript aiData domain topics')
      .lean();
  } catch (_) { /* content optional — degrade to general tutoring */ }

  const contentTitle = content?.title || 'this lesson';

  // Persist the user turn (tagged with contentRef) before the LLM call.
  await appendToThread(userId, 'user', message, {
    mode: 'tutor', contentRef: contentId, contentTitle,
  });

  // Pull recent thread history if the client didn't pass any.
  let effectiveHistory = history;
  if (!history || history.length === 0) {
    try {
      const thread = await getOrCreateActiveThread(userId);
      effectiveHistory = (thread?.messages || []).slice(-8, -1).map(m => ({ role: m.role, content: m.content }));
    } catch (_) {}
  }

  // Build the tutor-scoped system prompt. Grounded in the content, but the
  // learner's objective/plan context (already in systemPrompt) still applies.
  const hasTranscript = !!(content?.transcript && content.transcript.length > 50);
  const grounding = content ? [
    `\n\n[TUTOR MODE — scoped to: "${contentTitle}"]`,
    content.description ? `Description: ${content.description}` : '',
    Array.isArray(content?.aiData?.keyConcepts) && content.aiData.keyConcepts.length
      ? `Key concepts: ${content.aiData.keyConcepts.join(', ')}` : '',
    content?.aiData?.summary ? `Summary: ${content.aiData.summary}` : '',
    hasTranscript
      ? `Transcript (ground answers in this; cite approximate timestamps when relevant):\n${String(content.transcript).slice(0, 6000)}`
      : `No full transcript available — answer from the title, description, and key concepts; say "based on this lesson's key concepts" rather than quoting.`,
  ].filter(Boolean).join('\n') : `\n\n[TUTOR MODE — the learner is asking about a lesson, content details unavailable. Help with the concept, tie it back to their objective.]`;

  const tutorRules = [
    '\n\nTutor rules:',
    `- You help the learner understand "${contentTitle}" specifically. Stay scoped to this lesson and tightly-adjacent concepts (prerequisites, examples, clarifications).`,
    '- If asked something clearly off-topic, decline in 1-2 sentences and redirect to the lesson.',
    '- Concise (2-4 short paragraphs max unless more is explicitly requested). Friendly, like a sharp study buddy.',
    '- End with up to 3 short follow-up suggestions as a JSON code block: ```json\n{"followups":["…","…"]}\n```',
  ].join('\n');

  const fullSystem = systemPrompt + grounding + tutorRules;

  const { text, capped, tokensIn, tokensOut } = await callLLM({
    userId, systemPrompt: fullSystem, userPrompt: message, history: effectiveHistory,
    maxTokens: COMPASS_MAX_TOKENS,
  });

  if (capped) {
    const reply = "You've hit today's free Compass usage. Try again tomorrow or upgrade for higher limits.";
    await appendToThread(userId, 'assistant', reply, { mode: 'tutor', contentRef: contentId, contentTitle });
    return { mode: 'tutor', output: { reply, followups: [], contentTitle } };
  }
  if (!text) {
    const reply = "I had trouble with that just now — ask me again in a moment?";
    await appendToThread(userId, 'assistant', reply, { mode: 'tutor', contentRef: contentId, contentTitle });
    return { mode: 'tutor', output: { reply, followups: ['Retry'], contentTitle } };
  }

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

  await appendToThread(userId, 'assistant', reply, {
    mode: 'tutor', contentRef: contentId, contentTitle, followups, tokensIn, tokensOut,
  });

  return { mode: 'tutor', output: { reply, followups, contentTitle } };
}

/**
 * Personalized quiz configurator. Uses the learner's actual weakest topic +
 * recent activity to suggest a focused config the user can still override.
 */
function quizConfig({ ctx }) {
  const weakest    = ctx.knowledge.weakTopics[0];
  const secondWeak = ctx.knowledge.weakTopics[1];

  // Pick topic
  const topicValue = weakest ? weakest.topic : 'last_7_days';
  const topicLabel = weakest
    ? `${weakest.topic} (your weakest, ${weakest.mastery}%)`
    : 'Last 7 days of content';

  // Pick format based on mastery level — beginners get recall, mid gets application, advanced gets case
  const masteryFloor = weakest?.mastery ?? 40;
  const formatValue =
    masteryFloor < 30 ? 'recall'
    : masteryFloor < 60 ? 'application'
    : 'case_study';
  const formatLabel =
    formatValue === 'recall' ? 'Recall · foundations first'
    : formatValue === 'application' ? 'Application · real-world scenarios'
    : 'Case study · multi-part';

  // Difficulty matches the topic's mastery level
  const difficultyValue =
    masteryFloor < 30 ? 'easy'
    : masteryFloor < 60 ? 'medium'
    : 'hard';
  const difficultyLabel =
    difficultyValue === 'easy' ? 'Easy · build confidence'
    : difficultyValue === 'medium' ? 'Medium · stretch you'
    : 'Hard · pressure-test';

  // Count: more for weak topics so you actually learn
  const count = masteryFloor < 40 ? 10 : 7;

  // Headline reflects the personalization
  const headline = weakest
    ? `I'd focus on ${weakest.topic} — that's your biggest gap. Adjust anything below.`
    : 'Got it. Here\'s how I\'d set it up — change anything you want.';

  return {
    mode: 'quiz_config',
    output: {
      headline,
      config: {
        topic:      { value: topicValue,  label: topicLabel },
        format:     { value: formatValue, label: formatLabel },
        difficulty: { value: difficultyValue, label: difficultyLabel },
        count:      { value: count, label: `${count} questions` },
        tagToObjective: { value: true, label: 'Count toward readiness' },
      },
      estimateMin: count <= 7 ? 6 : 9,
      startEndpoint: '/api/v1/quizzes/request',
      // Personalization rationale — surfaced for tester debugging
      personalizationReason: weakest
        ? `Weakest topic: ${weakest.topic} at ${weakest.mastery}%${secondWeak ? `; also weak: ${secondWeak.topic} at ${secondWeak.mastery}%` : ''}`
        : 'No mastery data yet — defaulting to last 7 days of content',
    },
  };
}

/**
 * Personalized interview configurator. Tailors type to objective:
 *   - Career switch / interview prep → behavioral first (storytelling matters)
 *   - SDE roles → technical
 *   - Consulting/case roles → case
 *   - Otherwise → mixed
 */
function interviewConfig({ ctx }) {
  const specifics = ctx.objective?.specifics || {};
  const targetRole = specifics.targetRole || 'general role';
  const targetCompany = specifics.targetCompany;

  // Type heuristic by role
  const role = (targetRole || '').toLowerCase();
  let typeValue, typeLabel;
  if (/sde|software|developer|engineer/.test(role) && !/manager|director/.test(role)) {
    typeValue = 'technical'; typeLabel = 'Technical · DSA + system design';
  } else if (/consult|strategy|case/.test(role)) {
    typeValue = 'case_study'; typeLabel = 'Case study · structured';
  } else if (/product manager|pm\b/.test(role)) {
    typeValue = 'mixed'; typeLabel = 'Mixed · PM behavioral + case';
  } else if (/data|analyst|scientist/.test(role)) {
    typeValue = 'mixed'; typeLabel = 'Mixed · technical + behavioral';
  } else {
    typeValue = 'behavioral'; typeLabel = 'Behavioral · stories + STAR';
  }

  // Seniority from currentLevel
  const seniorityValue =
    ctx.objective?.currentLevel === 'advanced' ? 'senior'
    : ctx.objective?.currentLevel === 'intermediate' ? 'mid'
    : 'junior';
  const seniorityLabel =
    seniorityValue === 'senior' ? 'Senior'
    : seniorityValue === 'mid' ? 'Mid-level'
    : 'Junior';

  // Headline reflects the personalization
  const roleLabel = targetCompany ? `${targetRole} @ ${targetCompany}` : targetRole;
  const headline = roleLabel && roleLabel !== 'general role'
    ? `Mock interview for ${roleLabel}. Adjust if you'd like.`
    : 'Mock interview — adjust if needed.';

  return {
    mode: 'interview_config',
    output: {
      headline,
      config: {
        type:        { value: typeValue, label: typeLabel },
        targetRole:  { value: targetRole, label: roleLabel || targetRole },
        duration:    { value: 30, label: '30 min' },
        seniority:   { value: seniorityValue, label: seniorityLabel },
        tagToObjective: { value: true, label: 'Count toward readiness' },
      },
      startEndpoint: '/api/v1/interviews/start',
      personalizationReason: `Type chosen by role pattern: "${targetRole}". Seniority from currentLevel.`,
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
        // Persist the insight summary so it shows up in conversation history.
        const summary = parsed.items.map(i => i.text).join(' · ');
        await appendToThread(userId, 'assistant', summary, { mode: 'insight' });
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
  await appendToThread(userId, 'assistant',
    fallbackItems.map(i => i.text).join(' · '),
    { mode: 'insight' });
  return { mode: 'insight', output: { headline: 'Here\'s what I noticed.', items: fallbackItems } };
}

/**
 * Normalize incoming scope value from the client. Accepts the canonical
 * scopes plus a couple of common variants. Falls back to null when invalid.
 */
function normalizeScope(scope) {
  if (!scope || typeof scope !== 'string') return null;
  const s = scope.toLowerCase().trim();
  if (s === 'week'     || s === 'this_week'  || s === 'last_week') return 'week';
  if (s === 'month'    || s === 'this_month' || s === 'last_month') return 'month';
  if (s === 'all_time' || s === 'all'        || s === 'since_start') return 'all_time';
  if (s === 'topic'    || s === 'by_topic')   return 'topic';
  return null;
}

/**
 * Window in days for a given scope. `all_time` uses null (no lower bound).
 */
function windowDaysForScope(scope) {
  switch (scope) {
    case 'week':    return 7;
    case 'month':   return 30;
    case 'all_time':return null;
    case 'topic':   return 30; // topic mode defaults to a 30d window unless caller overrides
    default:        return 7;
  }
}

/**
 * Human-readable label for a scope — used in the LLM framing prompt.
 */
function coachFramingForScope(scope, topic) {
  switch (scope) {
    case 'week':     return 'this is a retrospective over the past week. Reference the last 7 days of activity, biggest gaps, and a suggested focus for next week.';
    case 'month':    return 'this is a retrospective over the past month. Reference the last 30 days of activity, biggest gaps, and patterns/streaks.';
    case 'all_time': return 'this is a retrospective across the learner\'s entire journey. Reference cumulative activity, where they\'ve grown, and where they\'re still soft.';
    case 'topic':    return `this is a focused coaching session on the topic "${topic || 'their chosen topic'}". Reference their performance on this topic and what to practice next.`;
    default:         return 'this is a coaching conversation. Reference recent activity.';
  }
}

/**
 * Compute activity for a window. `windowDays` may be a number (last N days) or
 * null (all-time). Optionally filtered by `topic` — restricts QuizAttempts
 * and contents to those tagged with the topic.
 *
 * Pulls completed quiz attempts, completed content, interview sessions, and
 * the topics touched across them. Deterministic — feeds the LLM real data.
 */
async function computeActivity(userId, { windowDays = 7, topic = null } = {}) {
  const QuizAttempt = require('../../models/QuizAttempt');
  const ContentProgress = require('../../models/ContentProgress');
  const InterviewSession = require('../../models/InterviewSession');

  const dateFilter = windowDays
    ? { $gte: new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000) }
    : null;

  const quizQuery = { userId, status: 'completed' };
  const contentQuery = { userId, isCompleted: true };
  const interviewQuery = { userId, status: { $in: ['completed', 'evaluated'] } };
  if (dateFilter) {
    quizQuery.completedAt = dateFilter;
    contentQuery.completedAt = dateFilter;
    interviewQuery.completedAt = dateFilter;
  }

  // Topic filter — best effort. QuizAttempt has topicBreakdown.topic; we
  // narrow by querying for it. Content filtering by topic is done post-fetch
  // since ContentProgress doesn't carry topic — we use the linked Content.
  if (topic) {
    quizQuery['topicBreakdown.topic'] = topic;
  }

  const [quizzes, contentDone, interviews] = await Promise.all([
    QuizAttempt.find(quizQuery).select('score topicBreakdown completedAt').lean().catch(() => []),
    ContentProgress.find(contentQuery).select('contentId completedAt').lean().catch(() => []),
    InterviewSession.find(interviewQuery).select('completedAt').lean().catch(() => []),
  ]);

  const topicsTouched = new Set();
  let scoreSum = 0, scoreCount = 0;
  let topicScoreSum = 0, topicScoreCount = 0;
  for (const q of quizzes) {
    if (typeof q.score === 'number') { scoreSum += q.score; scoreCount += 1; }
    for (const tb of (q.topicBreakdown || [])) {
      if (tb?.topic) topicsTouched.add(tb.topic);
      if (topic && tb?.topic === topic && typeof tb.score === 'number') {
        topicScoreSum += tb.score;
        topicScoreCount += 1;
      }
    }
  }
  const avgQuizScore = scoreCount ? Math.round(scoreSum / scoreCount) : null;

  return {
    quizzesTaken: quizzes.length,
    contentCompleted: contentDone.length,
    interviewsTaken: interviews.length,
    avgQuizScore,
    topicAvgScore: topicScoreCount ? Math.round(topicScoreSum / topicScoreCount) : null,
    topicsTouched: Array.from(topicsTouched).slice(0, 10),
    totalActivities: quizzes.length + contentDone.length + interviews.length,
  };
}

/**
 * Back-compat shim for any caller still using the 7-day name.
 */
async function computeLast7DaysActivity(userId) {
  return computeActivity(userId, { windowDays: 7 });
}

/**
 * Coach opener. Generalized retrospective — Compass summarizes the user's
 * activity over the chosen scope (week | month | all_time | topic), names
 * the 1-2 biggest mastery gaps (or topic-specific gaps), and proposes a
 * focused next move. Subsequent turns flow through `conversation` with the
 * coach framing pinned for the same scope.
 */
async function coachOpener({ ctx, systemPrompt, userId, scope = 'week', topic = null, weekNumber }) {
  const windowDays = windowDaysForScope(scope);
  const activity = await computeActivity(userId, { windowDays, topic: scope === 'topic' ? topic : null });

  // Weakest topics for "biggest gaps" line — already on ctx, but ensure
  // we have at least one fallback even when topicProfiles is sparse.
  // For topic scope, anchor to the chosen topic.
  const gaps = (ctx.knowledge?.weakTopics || []).slice(0, 2);

  // Window label for the prompt + summary
  const windowLabel = (() => {
    switch (scope) {
      case 'week':     return 'past 7 days';
      case 'month':    return 'past 30 days';
      case 'all_time': return 'entire journey so far';
      case 'topic':    return `recent activity on "${topic || 'this topic'}"`;
      default:         return 'recent activity';
    }
  })();

  // Build a deterministic data envelope the LLM grounds its message in.
  const dataBlock = {
    scope,
    topic: topic || null,
    windowLabel,
    weekNumber: weekNumber || ctx.plan?.currentWeek || null,
    activity,
    biggestGaps: gaps.map(g => ({ topic: g.topic, mastery: g.mastery })),
    planProgress: ctx.plan ? {
      week: ctx.plan.currentWeek,
      totalWeeks: ctx.plan.totalWeeks,
      tasksDoneThisWeek: ctx.plan.tasksDoneThisWeek,
      tasksTotalThisWeek: ctx.plan.tasksTotalThisWeek,
      readiness: ctx.readiness?.value ?? null,
    } : null,
    recentlyAskedTutorAbout: ctx.deep?.recentTutor || [],
    overdueForReview: (ctx.deep?.dueForReview || []).slice(0, 3),
  };

  const openingHint = (() => {
    switch (scope) {
      case 'week':     return `"Looking at your last week…"`;
      case 'month':    return `"Looking at your last month…"`;
      case 'all_time': return `"Across your whole journey so far…"`;
      case 'topic':    return `"Focusing on ${topic || 'this topic'}…"`;
      default:         return `"Here's what I see…"`;
    }
  })();

  const userPrompt = [
    `Write the OPENING message of a Compass Coach session for the learner. Scope: ${scope}${topic ? ` (topic: ${topic})` : ''}.`,
    `Open with a phrase like ${openingHint}`,
    `Ground every number in the data below — DO NOT invent stats.`,
    `Structure (short paragraphs, no bullet headers):`,
    `1) One warm sentence acknowledging the ${windowLabel}.`,
    `2) A 1-2 sentence recap of what they did (real counts; if zero, be honest — "this was a quiet stretch").`,
    `3) Their 1-2 biggest gaps from biggestGaps (name the topic + mastery %). For topic scope, focus on their performance on ${topic || 'the chosen topic'} specifically.`,
    `4) ONE concrete suggested next move tied to the biggest gap (or the topic for topic scope).`,
    `5) End with an open question inviting them to reflect (e.g. "How did this stretch feel?" / "What got in the way?" / "What do you want to lock in next?").`,
    ``,
    `Keep total length 4-6 short sentences. Warm, honest, conversational.`,
    `End with up to 3 short follow-up suggestions as a JSON code block: \`\`\`json\n{"followups":["…","…","…"]}\n\`\`\``,
    ``,
    `DATA:\n${JSON.stringify(dataBlock, null, 2)}`,
  ].join('\n');

  const { text, capped, tokensIn, tokensOut } = await callLLM({
    userId,
    systemPrompt: systemPrompt + `\n[Mode: coach — ${coachFramingForScope(scope, topic)} Reference real numbers from the DATA block. Be warm but honest.]`,
    userPrompt,
    maxTokens: 700,
  });

  // Deterministic fallback when LLM is capped/unavailable — still useful.
  const fallback = () => {
    const a = activity;
    const recap = a.totalActivities === 0
      ? `This was a quiet ${scope === 'all_time' ? 'stretch' : scope} — no quizzes, content, or interviews logged.`
      : `You completed ${a.quizzesTaken} quiz${a.quizzesTaken === 1 ? '' : 'zes'}, ${a.contentCompleted} piece${a.contentCompleted === 1 ? '' : 's'} of content, and ${a.interviewsTaken} interview${a.interviewsTaken === 1 ? '' : 's'}${a.avgQuizScore !== null ? ` (avg quiz score ${a.avgQuizScore}%)` : ''}.`;
    const gapLine = scope === 'topic' && topic
      ? (a.topicAvgScore !== null
          ? `On ${topic} specifically, your average is ${a.topicAvgScore}%.`
          : `We don't have enough data on ${topic} yet to call out where you stand.`)
      : (gaps[0]
          ? `Your biggest gap is still ${gaps[0].topic} at ${gaps[0].mastery}%${gaps[1] ? `, with ${gaps[1].topic} (${gaps[1].mastery}%) close behind` : ''}.`
          : `We don't have enough data to call out a gap yet.`);
    const focus = scope === 'topic' && topic
      ? `Try one focused 15-minute quiz on ${topic} to move the needle.`
      : (gaps[0]
          ? `Next, let's put one focused session on ${gaps[0].topic} — even 15 minutes would move the needle.`
          : `Get one solid quiz in next so we can spot where to focus.`);
    return `${openingHint.replace(/[""]/g, '')} ${recap} ${gapLine} ${focus} How did this stretch actually feel?`;
  };

  let reply;
  let followups = [];
  if (capped || !text) {
    reply = fallback();
    followups = ['It went well', 'I got blocked', 'Plan what\'s next'];
  } else {
    reply = text;
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/i);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        if (Array.isArray(parsed.followups)) followups = parsed.followups.slice(0, 3);
      } catch (_) {}
      reply = text.replace(jsonMatch[0], '').trim();
    }
    if (followups.length === 0) {
      followups = ['It went well', 'I got blocked', 'Plan what\'s next'];
    }
  }

  await appendToThread(userId, 'assistant', reply, {
    mode: 'coach', followups, tokensIn, tokensOut,
  });

  return {
    mode: 'coach',
    output: {
      reply,
      followups,
      scope,
      topic: topic || null,
      summary: {
        weekNumber: dataBlock.weekNumber,
        windowLabel,
        activity,
        biggestGaps: dataBlock.biggestGaps,
      },
    },
  };
}

/**
 * Fetch the active thread for a user (or empty if none).
 * Used by the iOS Compass tab when it cold-starts to restore prior messages.
 */
async function getActiveThread(userId) {
  const thread = await getOrCreateActiveThread(userId);
  if (!thread) return { messages: [] };
  return {
    threadId: thread._id,
    title: thread.title,
    messageCount: thread.messageCount,
    lastMessageAt: thread.lastMessageAt,
    messages: (thread.messages || []).map(m => ({
      role: m.role,
      content: m.content,
      mode: m.mode,
      followups: m.followups || [],
      cards: m.cards || [],
      createdAt: m.createdAt,
    })),
  };
}

async function tutorResult({ systemPrompt, userId, topic, attemptId, beforeScore }) {
  const QuizAttempt = require('../../models/QuizAttempt');
  let checkScore = null;
  try {
    const attempt = await QuizAttempt.findOne({ _id: attemptId, userId }).lean();
    checkScore = attempt?.score?.percentage ?? null;
  } catch (_) {}
  const detail = await compassProgress.getTopicDetail(userId, topic).catch(() => null);
  const afterScore = detail?.score ?? null;
  const before = typeof beforeScore === 'number' ? beforeScore : null;
  const delta = (typeof afterScore === 'number' && before != null) ? Math.round(afterScore - before) : null;

  let nextTopic = null;
  try {
    const weak = await compassProgress.listWeakTopics(userId, 5);
    nextTopic = (weak.find((w) => w.topic !== topic) || weak[0])?.topic || null;
  } catch (_) {}

  const resultPrompt = systemPrompt +
    `\n\n[Mode: tutor_result] The learner just took a ${checkScore ?? '—'}% check on "${topic}". Their mastery is now ${afterScore ?? '—'}% (was ${before ?? '—'}%). In 2-3 warm sentences, reflect on how they did and what to revisit. Ground every number in the data above; DO NOT invent stats. No JSON block.`;
  const llmResult = await callLLM({ userId, systemPrompt: resultPrompt, userPrompt: `How did I do on the ${topic} check?`, maxTokens: 300 });
  const reply = llmResult.text || `You scored ${checkScore ?? '—'}% on the ${topic} check.`;
  const card = { type: 'tutoring_result', payload: { topic, checkScore, beforeScore: before, afterScore, delta } };
  await appendToThread(userId, 'assistant', reply, { mode: 'tutor_result', cards: [card], tokensIn: llmResult.tokensIn, tokensOut: llmResult.tokensOut });
  const output = { reply, followups: [], cards: [card] };
  if (nextTopic) output.suggested_action = { type: 'start_tutoring', topic: nextTopic, score: null };
  return { mode: 'tutor_result', output };
}

async function tutorTopic({ systemPrompt, userId, topic }) {
  if (!topic || typeof topic !== 'string') {
    return { mode: 'tutor_topic', output: { reply: 'Which topic would you like help with?', followups: [], cards: [] } };
  }
  const detail = await compassProgress.getTopicDetail(userId, topic).catch(() => null);
  const misc = (detail?.misconceptions || []).map((m) => `${m.tag}: ${m.explanation}`).join('; ');
  const tutorPrompt = systemPrompt +
    `\n\n[Mode: tutor_topic] You are tutoring the learner on "${topic}". They are ${detail?.level || 'an unknown level'} (${detail?.score ?? '—'}%).` +
    (misc ? ` Their recurring misconceptions: ${misc}.` : '') +
    ` Teach concisely (4-8 sentences) with 1-2 short worked examples that DIRECTLY fix those misconceptions. Don't dump everything about the topic. End by inviting a quick check. Do not include any JSON block.`;
  const llmResult = await callLLM({ userId, systemPrompt: tutorPrompt, userPrompt: `Help me understand ${topic}.`, maxTokens: COMPASS_MAX_TOKENS });
  if (llmResult.capped) {
    const reply = "You've hit today's free Compass usage. Try again tomorrow or upgrade for higher limits.";
    await appendToThread(userId, 'assistant', reply, { mode: 'tutor_topic' });
    return { mode: 'tutor_topic', output: { reply, followups: [], cards: [] } };
  }
  const reply = llmResult.text || `Let's work on ${topic}. Ready for a quick check?`;
  const cards = detail ? [{ type: 'topic_detail', payload: detail }] : [];
  const suggested_action = { type: 'start_check_quiz', topic, question_count: 4, before_score: detail?.score ?? null };
  await appendToThread(userId, 'assistant', reply, { mode: 'tutor_topic', cards, tokensIn: llmResult.tokensIn, tokensOut: llmResult.tokensOut });
  return { mode: 'tutor_topic', output: { reply, followups: [], cards, suggested_action } };
}

/**
 * If the response carries a weak_topics or readiness_explanation card and no
 * suggested_action is set, attach a start_tutoring offer for the top weak topic.
 * Best-effort, pure, never throws.
 */
function attachProactiveTutoringOffer(response) {
  try {
    if (!response || !response.output || response.output.suggested_action) return;
    const cards = response.output.cards || [];
    const weak = cards.find((c) => c.type === 'weak_topics');
    if (weak && Array.isArray(weak.payload?.topics) && weak.payload.topics.length) {
      const t = weak.payload.topics[0];
      response.output.suggested_action = { type: 'start_tutoring', topic: t.topic, score: t.score ?? null };
      return;
    }
    const readiness = cards.find((c) => c.type === 'readiness_explanation');
    if (readiness && Array.isArray(readiness.payload?.topDraggers) && readiness.payload.topDraggers.length) {
      const d = readiness.payload.topDraggers[0];
      response.output.suggested_action = { type: 'start_tutoring', topic: d.name, score: d.score ?? null };
    }
  } catch (_) {}
}

/**
 * Archive the current active thread so the next interaction starts fresh.
 */
async function resetActiveThread(userId) {
  await CompassConversation.updateMany(
    { userId, isArchived: false },
    { $set: { isArchived: true } }
  );
  return { reset: true };
}

module.exports = {
  handle,
  buildUserContext,
  buildSystemContext,
  callLLMWithTools,
  conversation,
  getActiveThread,
  resetActiveThread,
  getBudgetUsage,
  attachProactiveTutoringOffer,
};

