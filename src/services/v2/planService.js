/**
 * v2 Plan helpers shared between /api/v2/plan/today and /api/v2/you/plan/detail.
 *
 * Pure functions: no I/O except where noted. Reads from the in-memory Plan
 * doc + KnowledgeProfile + UserObjective and returns shapes the routes can
 * compose. Extracted from routes/v2/plan.js so the new You-tab plan-detail
 * endpoint can reuse the same projection/aggregation logic without
 * duplicating it (and risking drift).
 */

/**
 * Pretty-print a canonical kebab-case topic name as "Title Cased" string.
 */
function prettyTopicName(s) {
  return String(s || '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Look up mastery for a canonical topic name from a KnowledgeProfile doc.
 * Handles both shapes the codebase uses (topicProfiles map + topicMastery array).
 */
function masteryForTopic(knowledge, canonicalName) {
  if (!knowledge || !canonicalName) return 0;
  // Preferred (newer) shape: topicProfiles map keyed by canonical name.
  const fromProfiles = knowledge.topicProfiles?.[canonicalName]?.masteryLevel;
  if (typeof fromProfiles === 'number') return fromProfiles;
  // Fallback shape: topicMastery array.
  const entry = (knowledge.topicMastery || []).find(t => t.topic === canonicalName);
  if (entry && typeof entry.score === 'number') return entry.score;
  return 0;
}

/**
 * Project expected readiness at end-of-week N for a plan that runs `totalWeeks`
 * weeks from `baselineReadiness` toward 80% target. Deterministic linear ramp.
 */
function projectReadinessAtWeek({ baseline, targetReadiness, totalWeeks, weekNumber }) {
  if (totalWeeks <= 0) return baseline;
  const ratio = Math.min(1, Math.max(0, weekNumber / totalWeeks));
  return Math.round(baseline + (targetReadiness - baseline) * ratio);
}

/**
 * Group a plan's weeks into named phases sized by the plan length.
 *
 *   ≤4  weeks  → Foundations (first half) + Push (second half)
 *   ≤8  weeks  → Foundations / Build / Polish (1/3 split)
 *   ≤16 weeks  → Foundations / Build / Push / Polish (1/4 split)
 *   else        → Foundations / Build / Polish (1/3 split)
 *
 * Names lean lightly objective-aware (test-prep vs skill-ramp).
 */
function buildPhases({ plan, objective }) {
  if (!plan || !Array.isArray(plan.weeklySchedule) || plan.weeklySchedule.length === 0) {
    return [];
  }
  const weeks = plan.weeklySchedule.map(w => w.week).sort((a, b) => a - b);
  const total = weeks.length;
  const isExamPrep = objective?.objectiveType === 'exam_preparation';
  const isInterview = objective?.objectiveType === 'interview_preparation';

  let buckets; // array of [startWeek, endWeek] ranges
  if (total <= 4) {
    const mid = Math.ceil(total / 2);
    buckets = [
      [weeks[0], weeks[mid - 1]],
      [weeks[mid] ?? weeks[mid - 1], weeks[total - 1]],
    ];
  } else if (total <= 8) {
    const a = Math.ceil(total / 3);
    const b = Math.ceil((2 * total) / 3);
    buckets = [
      [weeks[0], weeks[a - 1]],
      [weeks[a], weeks[b - 1]],
      [weeks[b], weeks[total - 1]],
    ];
  } else if (total <= 16) {
    const q = Math.floor(total / 4);
    buckets = [
      [weeks[0], weeks[q - 1]],
      [weeks[q], weeks[2 * q - 1]],
      [weeks[2 * q], weeks[3 * q - 1]],
      [weeks[3 * q], weeks[total - 1]],
    ];
  } else {
    const a = Math.ceil(total / 3);
    const b = Math.ceil((2 * total) / 3);
    buckets = [
      [weeks[0], weeks[a - 1]],
      [weeks[a], weeks[b - 1]],
      [weeks[b], weeks[total - 1]],
    ];
  }
  // De-dup any collapsed ranges
  buckets = buckets.filter(([s, e], i, arr) =>
    s != null && e != null && (i === 0 || s > arr[i - 1][1])
  );

  const phaseNames = buckets.length === 2
    ? (isExamPrep ? ['Foundations', 'Test push'] : isInterview ? ['Foundations', 'Mock push'] : ['Foundations', 'Push'])
    : buckets.length === 3
      ? (isExamPrep ? ['Foundations', 'Build', 'Test polish'] : ['Foundations', 'Build', 'Polish'])
      : ['Foundations', 'Build', 'Push', 'Polish'];

  return buckets.map(([startWeek, endWeek], i) => {
    const range = [];
    for (let w = startWeek; w <= endWeek; w++) range.push(w);
    // Compute focus from the topics covered in this phase. Filter out
    // placeholder topic names (_objective, _general, empty/null) so the UI
    // doesn't display raw template tokens to the user.
    const topics = new Set();
    for (const w of range) {
      const wk = plan.weeklySchedule.find(x => x.week === w);
      for (const t of (wk?.tasks || [])) {
        const name = t.topic?.canonicalName;
        if (name && !name.startsWith('_') && name.trim().length > 0) {
          topics.add(name);
        }
      }
    }
    const topicList = Array.from(topics).slice(0, 3).map(prettyTopicName).join(', ');
    const name = phaseNames[i] || `Phase ${i + 1}`;
    return {
      name,
      weeks: range,
      focus: topicList ? `Focus topics: ${topicList}` : 'Building toward your goal.',
      rationale: phaseRationale(name, i, buckets.length, objective),
    };
  });
}

function phaseRationale(name, index, totalPhases, objective) {
  const goalLabel = objective?.specifics?.examName
    || objective?.specifics?.targetRole
    || objective?.specifics?.targetSkill
    || 'your goal';
  if (/foundation/i.test(name)) return `Close the biggest gaps before they compound — everything in later weeks builds on this.`;
  if (/build/i.test(name))      return `Layer in tougher material now that the basics are in place.`;
  if (/push/i.test(name))       return `Increase intensity. Tighter difficulty, longer sessions, mixed practice.`;
  if (/polish/i.test(name))     return `Lock it in. Mocks, timed reps, and review of soft spots before ${goalLabel}.`;
  return `Phase ${index + 1} of ${totalPhases} — keep stacking wins.`;
}

/**
 * Synthesize milestones from a plan: end of each phase + final goal date.
 * Returns up to 5.
 */
function buildMilestones({ plan, phases, baseline, targetReadiness, currentWeek, objective }) {
  if (!plan || !Array.isArray(plan.weeklySchedule) || plan.weeklySchedule.length === 0) {
    return [];
  }
  const totalWeeks = plan.weeklySchedule.length;
  const goalLabel = objective?.specifics?.examName
    || objective?.specifics?.targetRole
    || objective?.specifics?.targetSkill
    || 'your goal';

  const out = [];
  // One milestone per phase end (capped at 4 phase milestones so total <=5 with final)
  for (const phase of (phases || []).slice(0, 4)) {
    const lastWeek = phase.weeks[phase.weeks.length - 1];
    if (lastWeek === totalWeeks) continue; // final milestone added separately below
    const expectedReadiness = projectReadinessAtWeek({ baseline, targetReadiness, totalWeeks, weekNumber: lastWeek });
    out.push({
      week: lastWeek,
      label: `${phase.name} complete`,
      expectedReadiness,
      isHit: currentWeek > lastWeek,
      isCurrent: currentWeek === lastWeek || (currentWeek > lastWeek && !out.some(m => m.isCurrent)),
    });
  }
  // Final milestone — the goal itself
  out.push({
    week: totalWeeks,
    label: `Goal: ${goalLabel}`,
    expectedReadiness: targetReadiness,
    isHit: false,
    isCurrent: currentWeek >= totalWeeks,
  });

  // Mark exactly one "current": prefer the next un-hit milestone.
  let foundCurrent = false;
  for (const m of out) { m.isCurrent = false; }
  for (const m of out) {
    if (!m.isHit && !foundCurrent) { m.isCurrent = true; foundCurrent = true; }
  }
  return out;
}

/**
 * Deterministic 2-3 sentence write-up of why this plan was generated.
 * No LLM call — built from objective specifics + KnowledgeProfile signals.
 */
function buildPlanWriteUp({ plan, objective, knowledge }) {
  if (!plan || !objective) return '';
  const totalWeeks = (plan.weeklySchedule || []).length || 0;
  const goalLabel = objective.specifics?.examName
    || objective.specifics?.targetRole
    || objective.specifics?.targetSkill
    || objective.objectiveType?.replace(/_/g, ' ')
    || 'your goal';

  // Weakest 3 topics by mastery (prefer topicProfiles, fallback topicMastery)
  const allTopics = [];
  if (knowledge?.topicProfiles) {
    for (const [name, t] of Object.entries(knowledge.topicProfiles)) {
      allTopics.push({ name, mastery: t.masteryLevel ?? 0 });
    }
  }
  if (allTopics.length === 0 && Array.isArray(knowledge?.topicMastery)) {
    for (const t of knowledge.topicMastery) {
      allTopics.push({ name: t.topic, mastery: t.score ?? 0 });
    }
  }
  const gaps = allTopics
    .filter(t => t.name)
    .sort((a, b) => a.mastery - b.mastery)
    .slice(0, 3);

  const phaseSplit = totalWeeks <= 4
    ? `Weeks 1-${Math.ceil(totalWeeks / 2)} build foundations; the rest add timed reps and harder practice.`
    : totalWeeks <= 8
      ? `Weeks 1-${Math.ceil(totalWeeks / 3)} close the basics, weeks ${Math.ceil(totalWeeks / 3) + 1}-${Math.ceil((2 * totalWeeks) / 3)} layer in tougher material, and the final weeks polish under pressure.`
      : `The first third closes basics, the middle layers in real-world application, and the final stretch is mocks and review under pressure.`;

  const gapSentence = gaps.length > 0
    ? `It focuses on closing your weakest areas first: ${gaps.map(g => `${prettyTopicName(g.name)} (currently ${Math.round(g.mastery)}%)`).join(', ')}.`
    : `It starts with broad-coverage assessments to identify your soft spots, then doubles down on whichever topics need the most work.`;

  return [
    `Your ${totalWeeks}-week ${goalLabel} plan is sequenced so each week builds on the previous one.`,
    gapSentence,
    phaseSplit,
  ].join(' ');
}

/**
 * Walk plan tasks and build a topic-coverage breakdown.
 */
function buildTopicCoverage({ plan, knowledge }) {
  if (!plan || !Array.isArray(plan.weeklySchedule)) return [];
  const byTopic = new Map();
  for (const w of plan.weeklySchedule) {
    for (const t of (w.tasks || [])) {
      const key = t.topic?.canonicalName;
      if (!key) continue;
      const entry = byTopic.get(key) || {
        topic: key,
        displayName: t.topic?.displayName || prettyTopicName(key),
        taskCount: 0,
        totalMinutes: 0,
      };
      entry.taskCount += 1;
      entry.totalMinutes += (t.payload?.estimatedMinutes || 0);
      byTopic.set(key, entry);
    }
  }
  const out = [];
  for (const entry of byTopic.values()) {
    const currentMastery = Math.round(masteryForTopic(knowledge, entry.topic));
    // Expected mastery: floor at +10 per 60 minutes of plan time, capped at 90.
    const lift = Math.min(40, Math.round(entry.totalMinutes / 6));
    out.push({
      topic: entry.topic,
      displayName: entry.displayName,
      taskCount: entry.taskCount,
      totalMinutes: entry.totalMinutes,
      currentMastery,
      expectedMastery: Math.min(95, currentMastery + lift),
    });
  }
  return out.sort((a, b) => a.currentMastery - b.currentMastery);
}

const TASK_TYPE_MAP = {
  in_app_content: 'watch',
  quiz:           'quiz',
  ai_interview:   'interview',
  external_link:  'external',
  competition:    'compete',
  manual:         'reflection',
};

function uiTaskType(rawType) {
  return TASK_TYPE_MAP[rawType] || 'reflection';
}

function difficultyLabel(d) {
  const n = d || 3;
  if (n >= 4) return 'hard';
  if (n <= 2) return 'easy';
  return 'medium';
}

/**
 * Shape a plan task for the detail view. Lighter than routes/v2/plan.js's
 * shapeTask — no impact prediction, no icon (UI carries it).
 */
function shapeTaskForDetail(task) {
  return {
    taskId: String(task._id),
    type: uiTaskType(task.type),
    title: task.payload?.title || task.topic?.displayName || 'Task',
    topic: task.topic?.canonicalName || null,
    topicDisplay: task.topic?.displayName || prettyTopicName(task.topic?.canonicalName),
    estimatedMinutes: task.payload?.estimatedMinutes || 15,
    difficulty: difficultyLabel(task.payload?.difficulty),
    status: task.progress?.status || 'pending',
    completedAt: task.progress?.completedAt || null,
    reason: task.payload?.reason || `Targets ${task.topic?.displayName || 'this topic'}.`,
    payload: {
      contentId:   task.payload?.contentId   || null,
      quizId:      task.payload?.quizId      || null,
      interviewId: task.payload?.interviewId || task.payload?.scenarioId || null,
      url:         task.payload?.url         || null,
      challengeId: task.payload?.challengeId || null,
    },
  };
}

/**
 * Build the weeks array for the plan-detail view.
 */
function buildWeeksDetail({ plan, baseline, targetReadiness, currentWeek }) {
  if (!plan || !Array.isArray(plan.weeklySchedule)) return [];
  const totalWeeks = plan.weeklySchedule.length;
  return plan.weeklySchedule.map(w => {
    const tasks = (w.tasks || []).map(shapeTaskForDetail);
    const done = tasks.filter(t => t.status === 'complete').length;
    const skipped = tasks.filter(t => t.status === 'skipped').length;
    const total = tasks.length;
    let status = 'pending';
    if (w.week < currentWeek) status = 'done';
    else if (w.week === currentWeek) status = total > 0 && done === total ? 'done' : 'in_progress';
    const focusTopics = Array.from(new Set(
      (w.tasks || []).map(t => t.topic?.canonicalName).filter(Boolean)
    )).slice(0, 4);
    return {
      week: w.week,
      isCurrent: w.week === currentWeek,
      status,
      focusTopics,
      tasks,
      done,
      skipped,
      total,
      expectedReadinessAtEnd: projectReadinessAtWeek({ baseline, targetReadiness, totalWeeks, weekNumber: w.week }),
      notes: w.weeklyGoal || null,
    };
  });
}

/**
 * Collect last 50 completed tasks across the entire plan, newest first.
 * For quiz tasks, join with QuizAttempt to surface the score.
 */
async function buildCompletedHistory({ plan, userId }) {
  if (!plan || !Array.isArray(plan.weeklySchedule)) return [];
  const completed = [];
  for (const w of plan.weeklySchedule) {
    for (const t of (w.tasks || [])) {
      if (t.progress?.status !== 'complete') continue;
      completed.push({
        taskId: String(t._id),
        type: uiTaskType(t.type),
        rawType: t.type,
        title: t.payload?.title || t.topic?.displayName || 'Task',
        topic: t.topic?.canonicalName || null,
        completedAt: t.progress?.completedAt || null,
        quizId: t.payload?.quizId || null,
      });
    }
  }
  completed.sort((a, b) => {
    const at = a.completedAt ? new Date(a.completedAt).getTime() : 0;
    const bt = b.completedAt ? new Date(b.completedAt).getTime() : 0;
    return bt - at;
  });
  const capped = completed.slice(0, 50);

  // Hydrate quiz scores. Single batched query for all quiz tasks we have ids for.
  const quizIds = capped.map(c => c.quizId).filter(Boolean);
  if (quizIds.length > 0) {
    try {
      const QuizAttempt = require('../../models/QuizAttempt');
      const attempts = await QuizAttempt.find({
        userId, quizId: { $in: quizIds }, status: 'completed',
      }).select('quizId score completedAt').lean();
      const scoreByQuiz = new Map();
      for (const a of attempts) {
        const k = String(a.quizId);
        const pct = Math.round(a.score?.percentage || 0);
        // Keep the most recent attempt's score per quiz
        const existing = scoreByQuiz.get(k);
        if (!existing || new Date(a.completedAt) > new Date(existing.at)) {
          scoreByQuiz.set(k, { score: pct, at: a.completedAt });
        }
      }
      for (const c of capped) {
        if (c.quizId) {
          const sc = scoreByQuiz.get(String(c.quizId));
          if (sc) c.score = sc.score;
        }
      }
    } catch (_) { /* non-fatal */ }
  }
  // Strip internal fields
  return capped.map(c => {
    const out = { taskId: c.taskId, type: c.type, title: c.title, topic: c.topic, completedAt: c.completedAt };
    if (typeof c.score === 'number') out.score = c.score;
    return out;
  });
}

/**
 * Aggregate plan-level summary numbers.
 */
function buildPlanSummary({ plan, baseline, targetReadiness, objective }) {
  if (!plan || !Array.isArray(plan.weeklySchedule)) {
    return {
      totalWeeks: 0, totalTasks: 0, completedTasks: 0, skippedTasks: 0, remainingTasks: 0,
      estimatedTotalHours: 0, investedHours: 0,
      currentReadiness: baseline,
      targetReadiness,
      projectedReadiness: baseline,
      onTrack: false, weeksLateVsDeadline: 0,
    };
  }
  const totalWeeks = plan.weeklySchedule.length;
  let totalTasks = 0, completedTasks = 0, skippedTasks = 0;
  let estimatedMin = 0, investedMin = 0;
  for (const w of plan.weeklySchedule) {
    for (const t of (w.tasks || [])) {
      totalTasks += 1;
      const est = t.payload?.estimatedMinutes || 0;
      estimatedMin += est;
      if (t.progress?.status === 'complete') {
        completedTasks += 1;
        investedMin += est;
      } else if (t.progress?.status === 'skipped') {
        skippedTasks += 1;
      }
    }
  }

  // Calendar drift — same logic as /plan/today.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const planStartedAt = plan.createdAt || plan.startedAt;
  const expectedWeek = planStartedAt
    ? Math.max(1, Math.floor((Date.now() - new Date(planStartedAt).getTime()) / (7 * DAY_MS)) + 1)
    : 1;

  // Current "plan week" = earliest week with any non-complete task.
  const firstIncomplete = plan.weeklySchedule.find(w =>
    (w.tasks || []).some(t => t.progress?.status !== 'complete')
  );
  const currentWeek = firstIncomplete?.week || totalWeeks;
  const weeksLateVsDeadline = Math.max(0, expectedWeek - currentWeek);

  // Pace projection: invested ratio over expected ratio determines pace.
  const expectedHours = (objective?.weeklyCommitHours || 5) * totalWeeks;
  const investedHours = Math.round((investedMin / 60) * 10) / 10;
  const paceRatio = expectedHours > 0
    ? Math.min(2, investedHours / Math.max(1, expectedHours * (Math.min(currentWeek, expectedWeek) / totalWeeks)))
    : 1;
  // Projected readiness at completion: scale the gap by pace ratio.
  const fullGap = Math.max(0, targetReadiness - baseline);
  const projectedReadiness = Math.min(95, Math.round(baseline + fullGap * Math.min(1.2, paceRatio)));
  const onTrack = weeksLateVsDeadline === 0 && projectedReadiness >= targetReadiness - 5;

  return {
    totalWeeks,
    totalTasks,
    completedTasks,
    skippedTasks,
    remainingTasks: Math.max(0, totalTasks - completedTasks - skippedTasks),
    estimatedTotalHours: Math.round(estimatedMin / 60),
    investedHours,
    currentReadiness: baseline,
    targetReadiness,
    projectedReadiness,
    onTrack,
    weeksLateVsDeadline,
  };
}

module.exports = {
  prettyTopicName,
  masteryForTopic,
  projectReadinessAtWeek,
  buildPhases,
  buildMilestones,
  buildPlanWriteUp,
  buildTopicCoverage,
  buildWeeksDetail,
  buildCompletedHistory,
  buildPlanSummary,
  uiTaskType,
};
