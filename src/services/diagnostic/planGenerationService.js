const openai = require('../../config/openai');
const taskCatalogService = require('../plan/taskCatalogService');

const BUFFER_FACTOR = 0.85;
const OVERESTIMATES_BUMP = 1.20;
const FUTURE_PROOFING_MIN_SHARE = 0.08;
const PLAN_LLM_TIMEOUT_MS = 60_000;
const LLM_MODEL = 'gpt-4o';

const SYSTEM_PROMPT = `You are an expert learning-plan designer for ScaleUp, an India-first learning platform.
Generate a personalized weekly schedule that respects the user's diagnostic results, timeline, and weekly hours.

CONSTRAINTS:
- Total allocated hours MUST be <= timeline_weeks * weeklyCommitHours * 0.85 (15% buffer for life events).
- Topics with calibrationClass = "overestimates" receive ~+20% hours over baseline (these are the user's blind spots).
- Topics with measuredBand = "novice" must appear early (foundational sequencing) — week 1 or 2.
- Topics with isFutureProofing: true must receive at least 8% of total hours.
- Milestones spaced meaningfully: every 4-8 weeks for short timelines (<= 12 weeks), every 8-12 for longer.
- If the user provided milestone hints, prefer those (mark isUserStated: true).

INDIA CONTEXT:
- Use Indian company examples (Razorpay, Flipkart, Zomato, TCS) where natural.
- For exam_preparation, mirror Indian exam style and dates.
- Avoid US-only product references unless target is explicitly US-based.

OUTPUT: weekly schedule (one entry per week 1..timeline), each with weeklyGoal + allocations (topic x hours x focusActivity).
Plan headline: 1-2 sentences, encouraging, specific.`;

const PLAN_RESPONSE_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'generated_plan',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        planHeadline: { type: 'string' },
        bufferRecommendation: { type: 'string' },
        weeklySchedule: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              week: { type: 'integer' },
              weeklyGoal: { type: 'string' },
              allocations: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    topicCanonicalName: { type: 'string' },
                    hours: { type: 'number' },
                    focusActivity: { type: 'string' },
                  },
                  required: ['topicCanonicalName', 'hours', 'focusActivity'],
                },
              },
            },
            required: ['week', 'weeklyGoal', 'allocations'],
          },
        },
        milestones: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              week: { type: 'integer' },
              title: { type: 'string' },
              measurableCriteria: { type: 'string' },
              isUserStated: { type: 'boolean' },
            },
            required: ['week', 'title', 'measurableCriteria', 'isUserStated'],
          },
        },
      },
      required: ['planHeadline', 'bufferRecommendation', 'weeklySchedule', 'milestones'],
    },
  },
};

function buildUserPrompt(input) {
  const { objectiveType, specificsCanonical, companyProfile, timeline, weeklyCommitHours, topicResults, userMilestoneHints } = input;
  return JSON.stringify({
    objectiveType,
    specificsCanonical,
    companyContext: companyProfile ? {
      name: companyProfile.name,
      signatureInterviewElements: companyProfile.signatureInterviewElements || [],
      examplesContext: companyProfile.examplesContext || '',
    } : null,
    timeline,
    weeklyCommitHours,
    capacityHoursWithBuffer: Math.round(timeline * weeklyCommitHours * BUFFER_FACTOR * 100) / 100,
    topics: topicResults.map(t => ({
      canonicalName: t.canonicalName,
      selfRating: t.selfRating,
      measuredScore: t.measuredScore,
      measuredBand: t.measuredBand,
      calibrationClass: t.calibrationClass,
      isFutureProofing: !!t.isFutureProofing,
      missedDifficulty: t.answerPattern || {},
    })),
    userMilestoneHints: userMilestoneHints || [],
  }, null, 2);
}

async function callLLM(input) {
  const completion = await Promise.race([
    openai.chat.completions.create({
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(input) },
      ],
      response_format: PLAN_RESPONSE_SCHEMA,
      temperature: 0.4,
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('PLAN_LLM_TIMEOUT')), PLAN_LLM_TIMEOUT_MS)),
  ]);
  const raw = completion?.choices?.[0]?.message?.content;
  if (!raw) throw new Error('PLAN_LLM_EMPTY_RESPONSE');
  return JSON.parse(raw);
}

function clampToCapacity(plan, timeline, weeklyCommitHours) {
  const cap = timeline * weeklyCommitHours * BUFFER_FACTOR;
  let total = 0;
  plan.weeklySchedule.forEach(w => w.allocations.forEach(a => { total += a.hours; }));
  if (total <= cap) return total;
  const scale = cap / total;
  let newTotal = 0;
  plan.weeklySchedule.forEach(w => w.allocations.forEach(a => {
    // Use floor to ensure rounding never pushes the scaled value above cap
    a.hours = Math.floor(a.hours * scale * 10) / 10;
    newTotal += a.hours;
  }));
  return newTotal;
}

function computeBaselineWeights(topicResults) {
  const weights = {};
  topicResults.forEach(t => {
    const baseInverse = Math.max(0.2, (100 - (t.measuredScore || 0)) / 100);
    let w = baseInverse;
    if (t.calibrationClass === 'overestimates') w *= OVERESTIMATES_BUMP;
    weights[t.canonicalName] = w;
  });
  return weights;
}

function buildTemplate(input) {
  const { timeline, weeklyCommitHours, topicResults, userMilestoneHints, objectiveType, specificsCanonical } = input;
  const cap = timeline * weeklyCommitHours * BUFFER_FACTOR;
  const weights = computeBaselineWeights(topicResults);
  const sumWeights = Object.values(weights).reduce((s, x) => s + x, 0) || 1;

  const totals = {};
  topicResults.forEach(t => {
    totals[t.canonicalName] = (weights[t.canonicalName] / sumWeights) * cap;
  });

  const fpMin = cap * FUTURE_PROOFING_MIN_SHARE;
  const fpTopics = topicResults.filter(t => t.isFutureProofing).map(t => t.canonicalName);
  fpTopics.forEach(name => {
    if (totals[name] < fpMin) {
      const deficit = fpMin - totals[name];
      totals[name] = fpMin;
      const nonFP = topicResults.filter(t => !t.isFutureProofing).map(t => t.canonicalName);
      const nonFPSum = nonFP.reduce((s, n) => s + totals[n], 0) || 1;
      nonFP.forEach(n => { totals[n] = Math.max(0, totals[n] - deficit * (totals[n] / nonFPSum)); });
    }
  });

  const noviceTopics = topicResults.filter(t => t.measuredBand === 'novice').map(t => t.canonicalName);

  const weeklySchedule = [];
  for (let w = 1; w <= timeline; w++) {
    const allocations = [];
    topicResults.forEach(t => {
      const perWeek = totals[t.canonicalName] / timeline;
      let hours = perWeek;
      if (noviceTopics.includes(t.canonicalName)) {
        hours = w === 1 ? perWeek * 1.4 : perWeek * 0.94;
      }
      if (hours >= 0.25) {
        allocations.push({
          topicCanonicalName: t.canonicalName,
          hours: Math.round(hours * 10) / 10,
          focusActivity: w === 1
            ? (t.measuredBand === 'novice' ? 'Foundations module + 1 application exercise' : 'Refresh + 1 applied scenario')
            : `Apply ${t.canonicalName.replace(/-/g, ' ')} to your ${specificsCanonical?.targetRole || objectiveType.replace(/_/g, ' ')} context`,
        });
      }
    });
    weeklySchedule.push({
      week: w,
      weeklyGoal: w === 1
        ? 'Anchor foundations on weakest topics'
        : (w === timeline ? 'Consolidate + final mock' : `Build depth — week ${w}`),
      allocations,
    });
  }

  const milestones = [];
  const intervals = timeline <= 6 ? [Math.ceil(timeline / 2), timeline] : [4, 8, 12].filter(w => w <= timeline);
  if (intervals[intervals.length - 1] !== timeline) intervals.push(timeline);
  intervals.forEach((w, i) => {
    milestones.push({
      week: w,
      title: i === intervals.length - 1 ? 'Final readiness checkpoint' : `Mid-plan checkpoint ${i + 1}`,
      measurableCriteria: 'Score >= 70 on review quiz across covered topics',
      isUserStated: false,
    });
  });
  (userMilestoneHints || []).forEach(h => {
    milestones.push({
      week: Math.min(timeline, h.week || timeline),
      title: h.title || 'User milestone',
      measurableCriteria: h.measurableCriteria || 'User-defined success criteria',
      isUserStated: true,
    });
  });
  milestones.sort((a, b) => a.week - b.week);

  return {
    planHeadline: `${timeline} weeks to your ${specificsCanonical?.targetRole || objectiveType.replace(/_/g, ' ')} goal — focused on your weakest areas first.`,
    bufferRecommendation: `We've reserved ~15% of your weekly time as buffer for life events.`,
    weeklySchedule,
    milestones,
  };
}

function sumTotalHours(plan) {
  let total = 0;
  plan.weeklySchedule.forEach(w => w.allocations.forEach(a => { total += a.hours; }));
  return Math.round(total * 10) / 10;
}

async function generate(input) {
  if (!input || !input.timeline || !input.weeklyCommitHours || !Array.isArray(input.topicResults)) {
    throw new Error('planGenerationService.generate: invalid input');
  }
  let plan;
  let source = 'llm-generated';
  let llmLatencyMs = null;
  try {
    const t0 = Date.now();
    plan = await callLLM(input);
    llmLatencyMs = Date.now() - t0;
  } catch (err) {
    console.warn('[planGenerationService] LLM failed, using template:', err.message);
    plan = buildTemplate(input);
    source = 'template';
  }
  clampToCapacity(plan, input.timeline, input.weeklyCommitHours);
  const estimatedTotalHours = sumTotalHours(plan);

  // Post-process: populate tasks[] per week from each allocation's topic.
  // Best-effort — a topic with no matching quiz/content yields no tasks for
  // that topic this week, but the rest of the plan is unaffected.
  for (const week of plan.weeklySchedule) {
    const tasks = [];
    for (const alloc of (week.allocations || [])) {
      let resolved;
      try {
        resolved = await taskCatalogService.resolveTopic({
          topicCanonicalName: alloc.topicCanonicalName,
          objectiveType: input.objectiveType,
          objectiveId: input.objectiveId,
        });
      } catch (err) {
        console.warn('[planGenerationService] taskCatalogService.resolveTopic failed:', err.message);
        continue;
      }
      const displayName = alloc.topicCanonicalName.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const topicShape = { canonicalName: alloc.topicCanonicalName, displayName };
      if (resolved.quizId) {
        tasks.push({
          type: 'quiz',
          topic: topicShape,
          payload: { quizId: resolved.quizId, estimatedMinutes: resolved.quizMinutes },
          completion: { mode: 'auto', requiresSelfRating: false },
          progress: { status: 'pending', completedAt: null, selfRating: null, sourceEventId: null },
        });
      }
      if (resolved.contentId) {
        tasks.push({
          type: 'in_app_content',
          topic: topicShape,
          payload: {
            contentId: resolved.contentId,
            contentType: resolved.contentType,
            estimatedMinutes: resolved.contentMinutes,
          },
          completion: { mode: 'auto', requiresSelfRating: false },
          progress: { status: 'pending', completedAt: null, selfRating: null, sourceEventId: null },
        });
      }

      // ai_interview — gated on interview-style objectives
      const interviewObjectives = ['interview_preparation', 'career_switch'];
      const emitsInterview = interviewObjectives.includes(input.objectiveType);
      if (emitsInterview) {
        const targetRoleLower = String(input.specificsCanonical?.targetRole || '').toLowerCase();
        let scenario = 'placement_behavioral';
        if (input.objectiveType === 'interview_preparation' && targetRoleLower.includes('mba')) {
          scenario = 'mba_admissions';
        } else if (/engineer|developer|programmer|data|ml|software/.test(targetRoleLower)) {
          scenario = 'placement_technical';
        }
        tasks.push({
          type: 'ai_interview',
          topic: topicShape,
          payload: { scenario, estimatedMinutes: 15 },
          completion: { mode: 'auto', requiresSelfRating: false },
          progress: { status: 'pending', completedAt: null, selfRating: null, sourceEventId: null },
        });
      }

      // competition — emit for every topic; tap launches competition tab filtered by topic
      tasks.push({
        type: 'competition',
        topic: topicShape,
        payload: { topicCanonicalName: alloc.topicCanonicalName, estimatedMinutes: 8 },
        completion: { mode: 'auto', requiresSelfRating: false },
        progress: { status: 'pending', completedAt: null, selfRating: null, sourceEventId: null },
      });

      // manual fallback — only when nothing else resolved for this topic
      const emittedNonCompetition = !!resolved.quizId || !!resolved.contentId || emitsInterview;
      if (!emittedNonCompetition) {
        tasks.push({
          type: 'manual',
          topic: topicShape,
          payload: {
            title: `Practice ${displayName} on your own`,
            description: `Spend ~30 minutes deepening your understanding of ${displayName}. Reading, exercises, or applying it to a real problem all count.`,
            estimatedMinutes: 30,
          },
          completion: { mode: 'manual', requiresSelfRating: true },
          progress: { status: 'pending', completedAt: null, selfRating: null, sourceEventId: null },
        });
      }
    }
    week.tasks = tasks;
  }

  return {
    planHeadline: plan.planHeadline,
    bufferRecommendation: plan.bufferRecommendation,
    weeklySchedule: plan.weeklySchedule,
    milestones: plan.milestones,
    estimatedTotalHours,
    source,
    llmLatencyMs,
    llmModel: source === 'llm-generated' ? LLM_MODEL : null,
  };
}

module.exports = {
  generate,
  buildTemplate,
  clampToCapacity,
  _internal: { SYSTEM_PROMPT, LLM_MODEL, BUFFER_FACTOR },
};
