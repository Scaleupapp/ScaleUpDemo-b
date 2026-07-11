const openai = require('../../config/openai');
const { OPENAI_CHAT_MODEL } = require('../../config/openaiModels');
const taskCatalogService = require('../plan/taskCatalogService');
const externalContentJudgeService = require('../plan/externalContentJudgeService');
const { predictTaskImpact } = require('../v2/predictedImpactService');

/**
 * Compute the predicted-impact payload for a task at generation time.
 * Stored on `payload.impact` so iOS Home / v2 "why this matters" can render
 * it without re-computing per request. Best-effort — failures don't block
 * task creation.
 *
 * Gated by the V2_API_ENABLED kill switch — when v2 is disabled this returns
 * null and plans generate exactly as they did in v1.
 */
function computeTaskImpact(taskType, alloc, displayName, topicResults) {
  if (process.env.V2_API_ENABLED === 'false') return null;
  try {
    const v1ToImpactType = {
      quiz: 'quiz',
      in_app_content: 'watch',
      ai_interview: 'interview',
      external_link: 'read',
      competition: 'quiz',
      manual: 'reflection',
    };
    const impactType = v1ToImpactType[taskType] || 'watch';
    const baseline = (topicResults || []).find(t => t.canonicalName === alloc.topicCanonicalName);
    const currentMastery = baseline?.measuredScore ?? 30;
    return predictTaskImpact({
      taskType: impactType,
      primaryTopic: displayName,
      currentMastery,
      difficulty: 3,
    });
  } catch (err) {
    console.warn('[planGeneration] impact predict failed:', err.message);
    return null;
  }
}

const BUFFER_FACTOR = 0.85;
const OVERESTIMATES_BUMP = 1.20;
const FUTURE_PROOFING_MIN_SHARE = 0.08;
const PLAN_LLM_TIMEOUT_MS = 60_000;
const LLM_MODEL = OPENAI_CHAT_MODEL;

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

  // Pre-resolve each unique topic exactly once, in parallel with a small
  // concurrency cap. Previously this loop ran resolveTopic for every
  // week × allocation (e.g. 12 × 6 = 72 calls), each potentially triggering
  // a 60s LLM quiz-gen. Now it's N (unique topic count) calls, in parallel,
  // which is the actual bound — cuts plan gen from 4-6 min to ~30-60s for a
  // 7-topic plan. Map keys on the raw topicCanonicalName since that's what
  // the per-week lookup uses.
  const uniqueTopics = Array.from(new Set(
    plan.weeklySchedule.flatMap(w => (w.allocations || []).map(a => a.topicCanonicalName))
  )).filter(Boolean);

  const resolvedByTopic = new Map();
  const CONCURRENCY = 4;
  for (let i = 0; i < uniqueTopics.length; i += CONCURRENCY) {
    const chunk = uniqueTopics.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(async (topic) => {
      try {
        // skipQuiz: true — quiz tasks are emitted WITHOUT a pre-baked quizId
        // (see resolveTopic for the full rationale). iOS routes quiz tasks
        // missing quizId through V2QuizRequestLoaderSheet which calls the
        // on-demand generator at tap time. We still resolve content for
        // in_app_content tasks.
        const r = await taskCatalogService.resolveTopic({
          topicCanonicalName: topic,
          objectiveType: input.objectiveType,
          objectiveId: input.objectiveId,
          userId: input.userId,
          skipQuiz: true,
        });
        return [topic, r];
      } catch (err) {
        console.warn('[planGenerationService] resolveTopic failed for', topic, ':', err.message);
        return [topic, null];
      }
    }));
    for (const [topic, r] of results) {
      if (r) resolvedByTopic.set(topic, r);
    }
  }

  // Post-process: populate tasks[] per week from each allocation's topic.
  // Best-effort — a topic with no matching content yields no in_app_content
  // task for that topic this week, but the rest of the plan is unaffected.
  //
  // Quiz tasks are ALWAYS emitted (no quizId pre-baked) — iOS resolves them
  // on demand via V2QuizRequestLoaderSheet, which keeps each week's quiz
  // fresh and avoids the 7-day Quiz `expiresAt` time bomb.
  for (const week of plan.weeklySchedule) {
    const tasks = [];
    for (const alloc of (week.allocations || [])) {
      const resolved = resolvedByTopic.get(alloc.topicCanonicalName) || {};
      const displayName = alloc.topicCanonicalName.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const topicShape = { canonicalName: alloc.topicCanonicalName, displayName };

      // Quiz task — always emit, no quizId. Payload carries weekNumber so the
      // on-demand generator can seed variant questions per week.
      tasks.push({
        type: 'quiz',
        topic: topicShape,
        payload: {
          topic: alloc.topicCanonicalName,
          weekNumber: week.week,
          estimatedMinutes: 8,
          impact: computeTaskImpact('quiz', alloc, displayName, input.topicResults),
        },
        completion: { mode: 'auto', requiresSelfRating: false },
        progress: { status: 'pending', completedAt: null, selfRating: null, sourceEventId: null },
      });

      if (resolved.contentId) {
        tasks.push({
          type: 'in_app_content',
          topic: topicShape,
          payload: {
            contentId: resolved.contentId,
            contentType: resolved.contentType,
            estimatedMinutes: resolved.contentMinutes,
            impact: computeTaskImpact('in_app_content', alloc, displayName, input.topicResults),
          },
          completion: { mode: 'auto', requiresSelfRating: false },
          progress: { status: 'pending', completedAt: null, selfRating: null, sourceEventId: null },
        });
      }

      // competition — emit for every topic; tap launches competition tab filtered by topic
      tasks.push({
        type: 'competition',
        topic: topicShape,
        payload: {
          topicCanonicalName: alloc.topicCanonicalName,
          estimatedMinutes: 8,
          impact: computeTaskImpact('competition', alloc, displayName, input.topicResults),
        },
        completion: { mode: 'auto', requiresSelfRating: false },
        progress: { status: 'pending', completedAt: null, selfRating: null, sourceEventId: null },
      });

      // Manual-practice fallback removed: every topic now ships a quiz task
      // (resolved on demand). Topics with no in-app content still have the
      // quiz + competition tasks to drive learning, so a generic "practice
      // this on your own" stub is redundant.

      // external_link tasks via LLM-as-judge — gated behind feature flag
      // because of latency/cost. When enabled, evaluates if in-app coverage
      // is enough for the user to advance one band; emits 0-3 vetted external
      // links if there are gaps.
      if (process.env.FEATURE_EXTERNAL_CONTENT_JUDGE === 'true') {
        const inAppContent = [];
        // Every topic ships an on-demand quiz now, so always treat that as
        // available in-app coverage when the judge weighs external content.
        inAppContent.push({ type: 'quiz', title: `Quiz on ${displayName}` });
        if (resolved.contentId) inAppContent.push({ type: 'content', title: `Content on ${displayName}` });
        const measuredBand = (input.topicResults || [])
          .find(t => t.canonicalName === alloc.topicCanonicalName)?.measuredBand || 'developing';
        try {
          const judgment = await externalContentJudgeService.judgeTopic({
            objectiveType: input.objectiveType,
            targetKey: `${input.objectiveType}::${input.specificsCanonical?.targetRole || input.specificsCanonical?.targetSkill || 'general'}`,
            topic: alloc.topicCanonicalName,
            measuredBand,
            inAppContent,
          });
          for (const link of (judgment.externalLinks || [])) {
            tasks.push({
              type: 'external_link',
              topic: topicShape,
              payload: {
                url: link.url,
                title: link.title,
                source: link.source,
                why: link.why,
                estimatedMinutes: link.estimatedMinutes,
              },
              completion: { mode: 'manual', requiresSelfRating: true },
              progress: { status: 'pending', completedAt: null, selfRating: null, sourceEventId: null },
            });
          }
        } catch (err) {
          console.warn('[planGenerationService] externalContentJudge failed:', err.message);
        }
      }
    }

    // Phase 6: ONE ai_interview task per week at the objective level (not per allocation).
    // Gated on objectives that genuinely call for interview practice.
    const isInterviewQualified = (() => {
      const t = input.objectiveType;
      // Read targetRole from canonical first, fall back to raw specifics for older users
      const targetRole = input.specificsCanonical?.targetRole || input.specifics?.targetRole;
      const hasTargetRole = !!targetRole;
      const wks = Number(input.timeline) || 0;

      if (t === 'interview_preparation') return true;
      if (t === 'career_switch') {
        return hasTargetRole && wks > 0 && wks <= 16;
      }
      // Phase-6-follow-up: if user is upskilling toward a specific role within a
      // realistic timeline, interview practice is valuable even though they didn't
      // pick the "interview_preparation" objective type. Many users mislabel
      // their objective in onboarding.
      if (t === 'upskilling') {
        return hasTargetRole && wks > 0 && wks <= 24;
      }
      return false;
    })();

    if (isInterviewQualified) {
      const targetRoleLower = String(input.specificsCanonical?.targetRole || input.specifics?.targetRole || '').toLowerCase();
      let scenario = 'placement_behavioral';
      if (input.objectiveType === 'interview_preparation' && /mba|admissions/.test(targetRoleLower)) {
        scenario = 'mba_admissions';
      } else if (/engineer|developer|sde|backend|frontend|fullstack|data\b|ml\b|ai\b/.test(targetRoleLower)) {
        scenario = (week.week % 2 === 0) ? 'placement_technical' : 'placement_behavioral';
      } else if (/product manager|^pm\b|growth|strategy|consulting|case/.test(targetRoleLower)) {
        scenario = (week.week % 2 === 0) ? 'case_study' : 'placement_behavioral';
      } else if (input.objectiveType === 'interview_preparation' && /(^|\b)hr|people|recruiter/.test(targetRoleLower)) {
        scenario = 'placement_hr';
      }

      // topicHints: this week's allocation topics — used as candidate topics for the interviewer.
      // Actual question weighting happens at startInterview time using live KnowledgeProfile data.
      const topicHints = (week.allocations || []).map(a => a.topicCanonicalName).slice(0, 6);

      tasks.push({
        type: 'ai_interview',
        topic: { canonicalName: '_objective', displayName: 'Mock interview' },
        payload: {
          scenario,
          estimatedMinutes: 15,
          topicHints,
        },
        completion: { mode: 'auto', requiresSelfRating: false },
        progress: { status: 'pending', completedAt: null, selfRating: null, sourceEventId: null },
      });
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
