// src/services/v2/compassProgressService.js
'use strict';

/**
 * Compass Progress Intelligence — the omniscient, real-time progress layer.
 *
 * Composes existing services (readiness, mastery, activity analytics) into:
 *   - getSnapshot(userId): a compact always-on digest injected into Compass's prompt
 *   - retrieval functions (added in later tasks) backing the read-only tools
 *
 * READ-ONLY. Nothing here mutates user state. Every slice is best-effort:
 * a failing source omits its slice rather than failing the whole snapshot.
 */

const readinessService = require('../readiness/readinessService');
const userContextService = require('../userContextService');
const KnowledgeProfile = require('../../models/KnowledgeProfile');
const Plan = require('../../models/Plan');
const QuizAttempt = require('../../models/QuizAttempt');
const InterviewSession = require('../../models/InterviewSession');
const ContentProgress = require('../../models/ContentProgress');
const CompetitionProfile = require('../../models/CompetitionProfile');
const CapstoneSession = require('../../coding/models/capstoneSession.model');
const ArtifactBundle = require('../../coding/models/artifactBundle.model');
const DrillAttempt = require('../../coding/models/drillAttempt.model');
const MetaSkillMastery = require('../../coding/models/metaSkillMastery.model');
const Content = require('../../models/Content');
const Quiz = require('../../models/Quiz');

const mongoose = require('mongoose');

const SNAPSHOT_TTL_MS = 90 * 1000;
// In-process cache — per Node process; invalidate() clears only this process's copy.
const _cache = new Map(); // userId -> { at, snap }

async function safe(fn, fallback) {
  try { return await fn(); } catch (e) { console.warn('[compassProgress]', e.message); return fallback; }
}

function avg(nums) {
  const xs = nums.filter((n) => typeof n === 'number' && !Number.isNaN(n));
  if (!xs.length) return null;
  return Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
}

async function getSnapshot(userId) {
  if (!userId) return null;
  const cached = _cache.get(String(userId));
  if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached.snap;

  const [readiness, mastery, pulse, signals] = await Promise.all([
    safe(() => buildReadinessSlice(userId), null),
    safe(() => buildMasterySlice(userId), { strong: [], weak: [] }),
    safe(() => buildPulseSlice(userId), emptyPulse()),
    safe(() => buildSignalsSlice(userId), emptySignals()),
  ]);

  const snap = { readiness, mastery, pulse, signals };
  _cache.set(String(userId), { at: Date.now(), snap });
  return snap;
}

function invalidate(userId) { _cache.delete(String(userId)); }

async function buildReadinessSlice(userId) {
  const r = await readinessService.getServedReadiness(userId);
  if (!r) return null;
  return {
    value: r.value, target: r.target, source: r.source, trend: r.trend || null,
    draggers: (r.draggers || []).slice(0, 3),
  };
}

async function buildMasterySlice(userId) {
  const kp = await KnowledgeProfile.findOne({ userId }).lean();
  const tm = (kp?.topicMastery || []).filter((t) => typeof t.score === 'number');
  const sorted = [...tm].sort((a, b) => b.score - a.score);
  const strong = sorted.filter((t) => t.score >= 75).slice(0, 3)
    .map((t) => ({ topic: t.topic, score: t.score, trend: t.trend || 'stable' }));
  const weak = sorted.filter((t) => t.score < 60 && (t.quizzesTaken || 0) >= 1).reverse().slice(0, 5)
    .map((t) => ({ topic: t.topic, score: t.score, trend: t.trend || 'stable' }));
  return { strong, weak };
}

function emptyPulse() {
  return {
    quizzes: { count: 0, avgPercent: null },
    interviews: { count: 0, avgScore: null, weakestDimension: null },
    coding: { gradedCount: 0, avgScore: null, axes: null },
    competitions: { count: 0, bestScore: null, streak: 0 },
    content: { completedCount: 0, minutesSpent: 0 },
    notes: { count: 0 },
  };
}

async function buildPulseSlice(userId) {
  const p = emptyPulse();
  const [quizzes, interviews, comp, contentAgg, capstones, drills, mastery, notesCount] = await Promise.all([
    safe(() => QuizAttempt.find({ userId, status: 'completed' }).sort({ completedAt: -1 }).limit(20).lean(), []),
    safe(() => InterviewSession.find({ userId, status: { $in: ['completed', 'evaluated'] } }).sort({ completedAt: -1 }).limit(20).lean(), []),
    safe(() => CompetitionProfile.findOne({ userId }).lean(), null),
    safe(() => {
      const userOid = mongoose.Types.ObjectId.isValid(userId) ? new mongoose.Types.ObjectId(String(userId)) : userId;
      return ContentProgress.aggregate([
        { $match: { userId: userOid, isCompleted: true } },
        { $group: { _id: null, count: { $sum: 1 }, totalTime: { $sum: '$totalTimeSpent' } } },
      ]);
    }, []),
    safe(() => CapstoneSession.find({ user_id: userId, status: 'graded' }).lean(), []),
    safe(() => DrillAttempt.find({ user_id: userId, status: 'graded' }).lean(), []),
    safe(() => MetaSkillMastery.findOne({ user_id: userId }).lean(), null),
    safe(() => Content.countDocuments({ creatorId: userId, contentType: 'notes' }), 0),
  ]);
  p.quizzes = { count: quizzes.length, avgPercent: avg(quizzes.map((q) => q.score?.percentage)) };
  const dims = ['communication', 'content', 'structure', 'confidence'];
  const dimAvgs = dims.map((d) => ({ d, v: avg(interviews.map((i) => i.evaluation?.[d]?.score)) })).filter((x) => x.v != null);
  dimAvgs.sort((a, b) => a.v - b.v);
  p.interviews = { count: interviews.length, avgScore: avg(interviews.map((i) => i.evaluation?.overallScore)), weakestDimension: dimAvgs[0]?.d || null };
  p.competitions = { count: comp?.totalChallengesCompleted || 0, bestScore: null, streak: comp?.currentChallengeStreak || 0 };
  const cInfo = contentAgg[0] || { count: 0, totalTime: 0 };
  p.content = { completedCount: cInfo.count, minutesSpent: Math.round((cInfo.totalTime || 0) / 60) };
  const allCodingScores = [
    ...capstones.map((s) => s.result?.overall_score),
    ...drills.map((d) => d.grade?.overall_score),
  ];
  const masteryAxes = mastery?.axes
    ? { prompting: mastery.axes.prompting, verification: mastery.axes.verification, decomposition: mastery.axes.decomposition, refactoring: mastery.axes.refactoring }
    : null;
  p.coding = { gradedCount: capstones.length + drills.length, avgScore: avg(allCodingScores), axes: masteryAxes };
  p.notes = { count: notesCount };
  return p;
}

function emptySignals() {
  return { dueForReviewCount: 0, dueConcepts: [], misconceptions: [], plan: null, streak: 0 };
}

async function buildSignalsSlice(userId) {
  const [deep, plan, comp] = await Promise.all([
    safe(() => userContextService.getUserContext(userId), null),
    safe(() => Plan.findOne({ userId, isActive: true }).lean(), null),
    safe(() => CompetitionProfile.findOne({ userId }).lean(), null),
  ]);
  const due = (deep?.dueForReview || []).map((d) => d.concept).filter(Boolean);
  return {
    dueForReviewCount: due.length,
    dueConcepts: due.slice(0, 5),
    misconceptions: (deep?.misconceptions || []).slice(0, 3).map((m) => ({ tag: m.tag, explanation: m.explanation })),
    plan: (() => {
      if (!plan) return null;
      const totalWeeks = (plan.weeklySchedule || []).length;
      const weeksElapsed = plan.createdAt ? Math.floor((Date.now() - new Date(plan.createdAt)) / (7 * 24 * 3600 * 1000)) + 1 : 1;
      const currentWeek = Math.min(Math.max(weeksElapsed, 1), Math.max(totalWeeks, 1));
      const wk = (plan.weeklySchedule || []).find((w) => w.week === currentWeek);
      const tasks = wk?.tasks || [];
      return {
        week: currentWeek,
        totalWeeks,
        tasksDone: tasks.filter((t) => t.progress?.status === 'complete' || t.progress?.completedAt).length,
        tasksTotal: tasks.length,
      };
    })(),
    streak: comp?.currentChallengeStreak || 0,
  };
}

function renderSnapshot(snap) {
  if (!snap) return '';
  const L = [];
  if (snap.readiness) {
    const d = (snap.readiness.draggers || []).map((x) => `${x.name} (${x.score}%)`).join(', ');
    L.push(`Readiness: ${snap.readiness.value}% (target ${snap.readiness.target}%, trend ${snap.readiness.trend || 'n/a'}).${d ? ` Dragging it down: ${d}.` : ''}`);
  }
  if (snap.mastery?.strong?.length) L.push(`Strong: ${snap.mastery.strong.map((t) => `${t.topic} ${t.score}%`).join(', ')}.`);
  if (snap.mastery?.weak?.length) L.push(`Weak: ${snap.mastery.weak.map((t) => `${t.topic} ${t.score}%`).join(', ')}.`);
  const p = snap.pulse;
  if (p) {
    L.push(`Activity: quizzes ${p.quizzes.count} (avg ${p.quizzes.avgPercent ?? '—'}%), interviews ${p.interviews.count} (avg ${p.interviews.avgScore ?? '—'}, weakest ${p.interviews.weakestDimension || '—'}), coding ${p.coding.gradedCount} graded, competitions ${p.competitions.count} (streak ${p.competitions.streak}), content ${p.content.completedCount} done, notes ${p.notes.count}.`);
  }
  const s = snap.signals;
  if (s) {
    if (s.dueForReviewCount) L.push(`Due for review: ${s.dueConcepts.join(', ')}.`);
    if (s.misconceptions?.length) L.push(`Recurring misconceptions: ${s.misconceptions.map((m) => m.tag).join(', ')}.`);
    if (s.plan) L.push(`Plan: week ${s.plan.week}/${s.plan.totalWeeks}, ${s.plan.tasksDone}/${s.plan.tasksTotal} tasks this week.`);
  }
  return L.join('\n');
}

function fmtDate(d) { return d ? new Date(d).toISOString().slice(0, 10) : null; }

async function getLatestResult(userId, type) {
  switch (type) {
    case 'quiz':        return quizResult(await QuizAttempt.findOne({ userId, status: 'completed' }).sort({ completedAt: -1 }).lean());
    case 'interview':   return interviewResult(await InterviewSession.findOne({ userId, status: { $in: ['completed', 'evaluated'] } }).sort({ completedAt: -1 }).lean());
    case 'coding':      return await codingResult(await CapstoneSession.findOne({ user_id: userId, status: 'graded' }).sort({ graded_at: -1 }).lean());
    case 'competition': return await competitionResult(userId);
    case 'content':     return contentResult(await ContentProgress.findOne({ userId, isCompleted: true }).sort({ completedAt: -1 }).lean());
    default:            return null;
  }
}

function quizResult(a) {
  if (!a) return null;
  const pct = a.score?.percentage ?? null;
  return {
    activityType: 'quiz', title: 'Quiz', date: fmtDate(a.completedAt),
    overallScore: pct, scoreLabel: pct != null ? `${pct}%` : '—',
    dimensions: (a.topicBreakdown || []).slice(0, 6).map((t) => ({ name: t.topic, score: t.percentage, feedback: null })),
    highlights: { strengths: (a.analysis?.strengths || []).slice(0, 3), improvements: (a.analysis?.weaknesses || []).slice(0, 3) },
  };
}

function interviewResult(s) {
  if (!s) return null;
  const e = s.evaluation || {};
  const dims = ['communication', 'content', 'structure', 'confidence']
    .filter((d) => e[d]).map((d) => ({ name: d, score: e[d].score, feedback: e[d].feedback || null }));
  return {
    activityType: 'interview', title: (s.interviewType || 'interview').replace(/_/g, ' '), date: fmtDate(s.completedAt),
    overallScore: e.overallScore ?? null, scoreLabel: e.overallScore != null ? `${e.overallScore}/100` : '—',
    dimensions: dims,
    highlights: { strengths: (e.overallStrengths || []).slice(0, 3), improvements: (e.overallImprovements || []).slice(0, 3) },
  };
}

async function codingResult(c) {
  if (!c) return null;
  const r = c.result || {};
  const ds = r.dimension_scores || {};
  const dims = Object.keys(ds).map((k) => ({ name: k.replace(/_/g, ' '), score: ds[k], feedback: r.dimension_feedback?.[k]?.to_improve || null }));
  let title = 'Capstone';
  try { const b = await ArtifactBundle.findById(c.bundle_id).lean(); if (b?.brief) title = String(b.brief).split('\n')[0].trim(); } catch (_) {}
  return {
    activityType: 'coding', title, date: fmtDate(c.graded_at),
    overallScore: r.overall_score ?? null, scoreLabel: r.overall_score != null ? `${r.overall_score}/100` : '—',
    dimensions: dims,
    highlights: { strengths: (r.strengths || []).slice(0, 3), improvements: (r.gaps || []).slice(0, 3) },
  };
}

async function competitionResult(userId) {
  try {
    const competitionService = require('../competitionService');
    const history = await competitionService.getCompetitionHistory(userId, 1);
    const h = Array.isArray(history) ? history[0] : (history?.items || history?.history || [])[0];
    if (!h) return null;
    return {
      activityType: 'competition', title: h.topic ? `Challenge: ${h.topic}` : 'Daily challenge', date: fmtDate(h.completedAt),
      overallScore: h.handicappedScore ?? h.rawScore ?? null, scoreLabel: h.rawScore != null ? `${h.rawScore}% (raw)` : '—',
      dimensions: [], highlights: { strengths: h.isPersonalBest ? ['personal best'] : [], improvements: [] },
    };
  } catch (_) { return null; }
}

function contentResult(c) {
  if (!c) return null;
  return {
    activityType: 'content', title: 'Recently completed content', date: fmtDate(c.completedAt),
    overallScore: c.percentageCompleted ?? null, scoreLabel: c.percentageCompleted != null ? `${c.percentageCompleted}% watched` : '—',
    dimensions: [], highlights: { strengths: [], improvements: [] },
  };
}

async function explainReadiness(userId) {
  const r = await readinessService.getServedReadiness(userId);
  if (!r) return { value: null, target: null, source: null, distanceToTarget: null, contributors: [], topDraggers: [], note: 'No readiness data yet — complete a quiz or assessment to start measuring.' };
  const contributors = Array.isArray(r.breakdown)
    ? r.breakdown.map((b) => ({ name: b.name, score: b.score, weight: b.weight ?? null, assessed: !!b.assessed }))
    : [];
  const topDraggers = (r.draggers || []).map((d) => ({ name: d.name, score: d.score, weight: d.weight ?? null }));
  const distanceToTarget = (typeof r.value === 'number' && typeof r.target === 'number') ? Math.max(0, r.target - r.value) : null;
  const note = contributors.length
    ? `Your readiness is ${r.value}% against a ${r.target}% target. It's a weighted blend of your competencies; the lowest-scoring assessed ones pull it down most.`
    : `Your readiness is ${r.value}% against a ${r.target}% target — currently the average of your assessed topic scores. The lowest are dragging it down.`;
  return { value: r.value, target: r.target, source: r.source, distanceToTarget, contributors, topDraggers, note };
}

module.exports = { getSnapshot, renderSnapshot, invalidate, explainReadiness, getLatestResult };
// export the formatters too (reused by findActivity in Task 4)
module.exports._fmt = { quizResult, interviewResult, codingResult, contentResult, fmtDate };
