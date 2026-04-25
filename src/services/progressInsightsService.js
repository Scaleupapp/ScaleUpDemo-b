/**
 * Progress Insights Service — Phase 1 (Signal Engine)
 *
 * Computes personalised learning insights for a given user from existing data
 * (KnowledgeProfile, QuizAttempt, ChallengeAttempt, ContentProgress, UserObjective).
 *
 * Pure deterministic math — no LLM. Phase 2 will layer GPT narrative on top of
 * the same `signals` object this service produces.
 *
 * Returns a structured response containing both the raw signals (for future
 * extensions) and a small set of "headline cards" the client renders directly.
 */

const KnowledgeProfile = require('../models/KnowledgeProfile');
const QuizAttempt = require('../models/QuizAttempt');
const ChallengeAttempt = require('../models/ChallengeAttempt');
const ContentProgress = require('../models/ContentProgress');
const UserObjective = require('../models/UserObjective');

// ──────────────────────────────────────────────────────────────
// Cache (in-memory, per-user, 15-minute TTL)
// Phase 3 will replace this with a ProgressInsightSnapshot collection.
// ──────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 15 * 60 * 1000;
const _cache = new Map(); // userId -> { value, expiresAt }

function _getCached(userId) {
  const entry = _cache.get(userId);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.value;
}

function _setCached(userId, value) {
  _cache.set(userId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function _invalidate(userId) {
  _cache.delete(userId);
}

// ──────────────────────────────────────────────────────────────
// Constants — tunable thresholds
// ──────────────────────────────────────────────────────────────
const T = {
  STALE_DAYS: 14,            // topic untouched this long is "stale"
  STALE_DAYS_CRITICAL: 21,   // stale + part of objective = critical
  IMPROVING_DELTA_PP: 8,     // pp gain to count as "improving"
  DECLINING_DELTA_PP: -10,   // pp drop to flag as declining
  ACCURACY_DROP_PP: 15,      // recent vs all-time gap = anomaly
  MIN_ATTEMPTS_FOR_TREND: 3, // need this many to trust a trend signal
  MIN_ATTEMPTS_FOR_ANOMALY: 5,
  COLD_START_QUIZ_COUNT: 0,  // no quizzes ever = cold start
  IDLE_DAYS: 14,             // user with quizzes but inactive this long
};

// ──────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────

/**
 * Generate insights for a user. Cached for 15 minutes.
 * Pass `{ refresh: true }` to bypass the cache.
 */
async function generateForUser(userId, opts = {}) {
  if (!opts.refresh) {
    const cached = _getCached(userId);
    if (cached) return cached;
  }

  const [profile, recentAttempts, recentChallenges, recentContent, objective] = await Promise.all([
    KnowledgeProfile.findOne({ userId }),
    QuizAttempt.find({ userId, completedAt: { $exists: true } })
      .sort({ completedAt: -1 })
      .limit(100) // last 100 attempts is plenty for our windows
      .lean(),
    ChallengeAttempt.find({ userId, completedAt: { $exists: true } })
      .sort({ completedAt: -1 })
      .limit(60)
      .lean(),
    ContentProgress.find({ userId, lastSessionAt: { $exists: true } })
      .sort({ lastSessionAt: -1 })
      .limit(80)
      .lean(),
    UserObjective.findOne({ userId, status: 'active', isPrimary: true }).lean(),
  ]);

  const state = _classifyState(profile, recentAttempts, recentChallenges);

  const signals = _computeSignals({
    profile,
    recentAttempts,
    recentChallenges,
    recentContent,
    objective,
  });

  const cards = _buildCards({ state, signals, profile, objective });

  const result = {
    state,
    cards,
    signals,
    objective: _objectiveSummary(objective, signals.objectiveAlignment),
    generatedAt: new Date().toISOString(),
    cacheTtlSeconds: CACHE_TTL_MS / 1000,
  };

  _setCached(userId, result);
  return result;
}

// ──────────────────────────────────────────────────────────────
// State classification
// ──────────────────────────────────────────────────────────────
function _classifyState(profile, attempts, challenges) {
  const totalQuizzes = profile?.totalQuizzesTaken ?? 0;
  if (totalQuizzes <= T.COLD_START_QUIZ_COUNT && challenges.length === 0) {
    return 'cold_start';
  }
  const lastActivity = _maxDate([
    attempts[0]?.completedAt,
    challenges[0]?.completedAt,
    profile?.lastUpdatedAt,
  ]);
  if (lastActivity && _daysBetween(lastActivity, new Date()) >= T.IDLE_DAYS) {
    return 'idle';
  }
  return 'active';
}

// ──────────────────────────────────────────────────────────────
// Signal computation
// ──────────────────────────────────────────────────────────────

function _computeSignals({ profile, recentAttempts, recentChallenges, recentContent, objective }) {
  const now = Date.now();

  return {
    windows: _computeWindows({ now, recentAttempts, recentChallenges, recentContent }),
    momentum: _computeMomentum(profile),
    milestones: _computeMilestones({ profile, recentAttempts }),
    anomalies: _computeAnomalies({ profile, recentAttempts }),
    objectiveAlignment: _computeObjectiveAlignment({ profile, objective, recentAttempts }),
  };
}

/** Activity counts and average scores across rolling time windows. */
function _computeWindows({ now, recentAttempts, recentChallenges, recentContent }) {
  const buckets = [
    { key: 'last_24h', hours: 24 },
    { key: 'last_48h', hours: 48 },
    { key: 'last_72h', hours: 72 },
    { key: 'last_7d', hours: 24 * 7 },
    { key: 'last_30d', hours: 24 * 30 },
  ];
  const out = {};
  for (const { key, hours } of buckets) {
    const cutoff = now - hours * 3600 * 1000;
    const aWin = recentAttempts.filter(a => new Date(a.completedAt).getTime() >= cutoff);
    const cWin = recentChallenges.filter(c => new Date(c.completedAt).getTime() >= cutoff);
    const ctWin = recentContent.filter(c => new Date(c.lastSessionAt).getTime() >= cutoff);

    const quizScores = aWin
      .map(a => a.score?.percentage)
      .filter(p => typeof p === 'number');
    const avgScore = quizScores.length
      ? Math.round(quizScores.reduce((s, p) => s + p, 0) / quizScores.length)
      : null;

    const minutesActive = ctWin.reduce((sum, c) => sum + (c.totalTimeSpent || 0), 0) / 60;

    const topicCounts = {};
    for (const a of aWin) {
      const t = (a.topicBreakdown?.[0]?.topic || a.quizId?.topic || a.topic || '').toString();
      if (t) topicCounts[t] = (topicCounts[t] || 0) + 1;
    }
    const topTopic = Object.entries(topicCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    out[key] = {
      quizzes: aWin.length,
      challenges: cWin.length,
      avgScore,
      minutesActive: Math.round(minutesActive),
      topTopic,
    };
  }
  return out;
}

/**
 * Topic-level momentum: improving / declining / stale.
 * Uses scoreHistory deltas — last 3 vs preceding 3 attempts on the topic.
 */
function _computeMomentum(profile) {
  if (!profile?.topicMastery?.length) {
    return { improving: [], declining: [], stale: [] };
  }
  const improving = [];
  const declining = [];
  const stale = [];
  const now = new Date();

  for (const tm of profile.topicMastery) {
    const history = (tm.scoreHistory || []).slice().sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );

    // Stale detection — works regardless of attempt count
    if (tm.lastAssessedAt) {
      const days = _daysBetween(tm.lastAssessedAt, now);
      if (days >= T.STALE_DAYS && tm.quizzesTaken >= T.MIN_ATTEMPTS_FOR_TREND) {
        stale.push({
          topic: tm.topic,
          daysSinceActivity: Math.round(days),
          lastScore: tm.score,
          level: tm.level,
        });
      }
    }

    // Trend detection — needs ≥ MIN_ATTEMPTS_FOR_TREND * 2 to compare windows
    if (history.length >= T.MIN_ATTEMPTS_FOR_TREND * 2) {
      const half = Math.floor(history.length / 2);
      const older = history.slice(0, half);
      const recent = history.slice(half);
      const avg = arr => arr.reduce((s, p) => s + (p.score || 0), 0) / arr.length;
      const olderAvg = avg(older);
      const recentAvg = avg(recent);
      const delta = Math.round(recentAvg - olderAvg);

      if (delta >= T.IMPROVING_DELTA_PP) {
        improving.push({
          topic: tm.topic, deltaPp: delta,
          fromScore: Math.round(olderAvg), toScore: Math.round(recentAvg),
          attempts: history.length, confidence: history.length >= 8 ? 'high' : 'medium',
        });
      } else if (delta <= T.DECLINING_DELTA_PP) {
        declining.push({
          topic: tm.topic, deltaPp: delta,
          fromScore: Math.round(olderAvg), toScore: Math.round(recentAvg),
          attempts: history.length, confidence: history.length >= 8 ? 'high' : 'medium',
        });
      }
    } else if (tm.trend === 'improving' || tm.trend === 'declining') {
      // Fall back to the trend the knowledge service already computed
      const bucket = tm.trend === 'improving' ? improving : declining;
      bucket.push({
        topic: tm.topic, deltaPp: null, fromScore: null, toScore: tm.score,
        attempts: tm.quizzesTaken, confidence: 'low',
      });
    }
  }

  // Stable sort: largest absolute delta first
  improving.sort((a, b) => (b.deltaPp || 0) - (a.deltaPp || 0));
  declining.sort((a, b) => (a.deltaPp || 0) - (b.deltaPp || 0));
  stale.sort((a, b) => b.daysSinceActivity - a.daysSinceActivity);

  return { improving, declining, stale };
}

/** Detect notable achievements in the last 7 days. */
function _computeMilestones({ profile, recentAttempts }) {
  const milestones = [];
  if (!profile) return milestones;
  const sevenDaysAgo = Date.now() - 7 * 86400000;

  // Level-ups: a topic whose current level differs from what its history
  // suggests it was 7+ days ago.
  for (const tm of profile.topicMastery || []) {
    const sortedHistory = (tm.scoreHistory || []).slice().sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );
    const oldEnough = sortedHistory.filter(h => new Date(h.date).getTime() < sevenDaysAgo);
    if (!oldEnough.length) continue;
    const oldLevel = _scoreToLevel(oldEnough[oldEnough.length - 1].score);
    if (oldLevel !== tm.level && _levelRank(tm.level) > _levelRank(oldLevel)) {
      milestones.push({
        type: 'level_up', topic: tm.topic,
        from: oldLevel, to: tm.level,
        date: tm.lastAssessedAt,
      });
    }
  }

  // First 90+ on any topic in the last 7 days
  for (const a of recentAttempts) {
    const ts = new Date(a.completedAt).getTime();
    if (ts < sevenDaysAgo) continue;
    const pct = a.score?.percentage;
    if (typeof pct !== 'number' || pct < 90) continue;
    const topic = a.topicBreakdown?.[0]?.topic || a.topic;
    if (!topic) continue;
    // Was their previous max for this topic < 90?
    const tm = profile.topicMastery?.find(t => t.topic === topic);
    if (!tm) continue;
    const prevMax = (tm.scoreHistory || [])
      .filter(h => new Date(h.date).getTime() < ts)
      .reduce((m, h) => Math.max(m, h.score || 0), 0);
    if (prevMax < 90) {
      milestones.push({ type: 'first_90_plus', topic, score: Math.round(pct), date: a.completedAt });
    }
  }

  // De-dupe (same topic + type within milestones)
  const seen = new Set();
  return milestones.filter(m => {
    const k = `${m.type}:${m.topic}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }).slice(0, 5);
}

/** Detect score drops + objective drift. */
function _computeAnomalies({ profile, recentAttempts }) {
  const anomalies = [];
  if (!profile?.topicMastery?.length || !recentAttempts.length) return anomalies;

  // Per-topic accuracy drop: avg of last N attempts vs all-time avg
  const byTopic = new Map();
  for (const a of recentAttempts) {
    const topic = a.topicBreakdown?.[0]?.topic || a.topic;
    if (!topic) continue;
    if (!byTopic.has(topic)) byTopic.set(topic, []);
    byTopic.get(topic).push(a);
  }

  for (const [topic, attempts] of byTopic.entries()) {
    if (attempts.length < T.MIN_ATTEMPTS_FOR_ANOMALY) continue;
    const last5 = attempts.slice(0, 5);
    const recentAvg = last5.reduce((s, a) => s + (a.score?.percentage || 0), 0) / last5.length;
    const tm = profile.topicMastery.find(t => t.topic === topic);
    const allTimeAvg = tm?.score ?? recentAvg;
    const delta = recentAvg - allTimeAvg;
    if (delta <= -T.ACCURACY_DROP_PP) {
      anomalies.push({
        type: 'accuracy_drop',
        topic,
        recentAvg: Math.round(recentAvg),
        baseline: Math.round(allTimeAvg),
        deltaPp: Math.round(delta),
        attempts: last5.length,
        severity: delta <= -25 ? 'high' : 'medium',
      });
    }
  }

  return anomalies.sort((a, b) => a.deltaPp - b.deltaPp).slice(0, 3);
}

/** How well is the user tracking against their stated objective? */
function _computeObjectiveAlignment({ profile, objective, recentAttempts }) {
  if (!objective) return null;
  const competencies = (objective.analysis?.competencies || []).map(c => c.name?.toLowerCase()).filter(Boolean);
  if (!competencies.length) {
    return {
      hasCompetencies: false,
      readinessPct: profile?.overallScore ?? null,
    };
  }

  // Score per linked competency: take topicMastery score where topic matches
  const matchScores = [];
  const blockers = [];
  const sevenDaysAgo = Date.now() - 7 * 86400000;
  for (const compName of competencies) {
    const tm = profile?.topicMastery?.find(t => {
      const topic = (t.topic || '').toLowerCase();
      return topic.includes(compName) || compName.includes(topic) ||
        compName.split(/[\s-]+/).some(w => topic.includes(w));
    });
    if (tm) {
      matchScores.push(tm.score);
      // Blocker: linked competency that's stale or below 50
      const days = tm.lastAssessedAt ? _daysBetween(tm.lastAssessedAt, new Date()) : null;
      if (tm.score < 50 || (days !== null && days >= T.STALE_DAYS)) {
        blockers.push({
          competency: compName,
          score: tm.score,
          daysSinceActivity: days !== null ? Math.round(days) : null,
          reason: tm.score < 50 ? 'low_score' : 'stale',
        });
      }
    } else {
      matchScores.push(0);
      blockers.push({ competency: compName, score: 0, daysSinceActivity: null, reason: 'untouched' });
    }
  }

  const readinessPct = matchScores.length
    ? Math.round(matchScores.reduce((s, v) => s + v, 0) / matchScores.length)
    : null;

  // Week delta: avg of objective-linked attempts in last 7d minus the equivalent in the prior 7d
  const inWindow = (a, fromMs, toMs) => {
    const ts = new Date(a.completedAt).getTime();
    return ts >= fromMs && ts < toMs;
  };
  const isLinked = a => {
    const t = (a.topicBreakdown?.[0]?.topic || a.topic || '').toLowerCase();
    return competencies.some(c => t.includes(c) || c.includes(t));
  };
  const fourteenDaysAgo = Date.now() - 14 * 86400000;
  const recent7 = recentAttempts.filter(a => isLinked(a) && inWindow(a, sevenDaysAgo, Date.now()));
  const prior7 = recentAttempts.filter(a => isLinked(a) && inWindow(a, fourteenDaysAgo, sevenDaysAgo));
  const avg = arr => arr.length ? arr.reduce((s, a) => s + (a.score?.percentage || 0), 0) / arr.length : null;
  const r7 = avg(recent7), p7 = avg(prior7);
  const weekDelta = (r7 != null && p7 != null) ? Math.round(r7 - p7) : null;

  // Days to target
  let daysToTarget = null;
  if (objective.targetDate) {
    daysToTarget = Math.max(0, Math.round(_daysBetween(new Date(), objective.targetDate)));
  }

  return {
    hasCompetencies: true,
    readinessPct,
    weekDelta,
    daysToTarget,
    blockers: blockers.slice(0, 3),
    competencyCount: competencies.length,
  };
}

// ──────────────────────────────────────────────────────────────
// Headline cards (what the FE renders)
// ──────────────────────────────────────────────────────────────

function _buildCards({ state, signals, profile, objective }) {
  if (state === 'cold_start') return _coldStartCards();
  if (state === 'idle') return _idleCards(signals, profile);

  const cards = [];

  // 1. "Last 48 hours" — always present in active state
  cards.push(_recentActivityCard(signals));

  // 2. "Where you're heading" — only if user has an objective
  const headingCard = _objectiveCard(signals.objectiveAlignment, objective);
  if (headingCard) cards.push(headingCard);

  // 3. "Worth your attention" — pull highest-priority anomaly/stale/declining
  const attentionCard = _attentionCard(signals);
  if (attentionCard) cards.push(attentionCard);

  // 4. Optional milestone celebration if any in the last 24h
  const celebrationCard = _milestoneCard(signals.milestones);
  if (celebrationCard) cards.push(celebrationCard);

  return cards;
}

function _coldStartCards() {
  return [{
    id: 'cold-start-welcome',
    kind: 'cold_start',
    icon: 'sparkles',
    tone: 'neutral',
    title: 'Welcome to Progress',
    body: 'Take your first quiz to unlock personalised insights about your strengths, weak spots, and learning trajectory.',
    cta: { label: 'Start a quiz', deeplink: 'scaleup://my-plan' },
  }];
}

function _idleCards(signals, profile) {
  const cards = [];
  const last30 = signals.windows.last_30d;
  cards.push({
    id: 'idle-welcome-back',
    kind: 'attention',
    icon: 'arrow.uturn.right.circle.fill',
    tone: 'caution',
    title: 'Welcome back',
    body: `It's been a while. You're at ${profile?.overallScore ?? 0}% overall mastery — a quick refresher quiz will help us re-tune your plan.`,
    cta: { label: 'Take a refresher', deeplink: 'scaleup://my-plan' },
  });
  if (last30.quizzes > 0) {
    cards.push({
      id: 'idle-prior-momentum',
      kind: 'momentum',
      icon: 'chart.line.uptrend.xyaxis',
      tone: 'neutral',
      title: 'Your recent baseline',
      body: `You averaged ${last30.avgScore ?? '—'}% across ${last30.quizzes} quiz${last30.quizzes === 1 ? '' : 'zes'} in the last 30 days. Pick up where you left off.`,
    });
  }
  return cards;
}

function _recentActivityCard(signals) {
  const w = signals.windows;
  // Prefer 48h window, fall back to 72h if 48h is empty
  let window = '48 hours', stats = w.last_48h;
  if (stats.quizzes === 0 && stats.challenges === 0) {
    window = '72 hours'; stats = w.last_72h;
  }
  if (stats.quizzes === 0 && stats.challenges === 0) {
    window = '7 days'; stats = w.last_7d;
  }

  const quizzes = stats.quizzes;
  const challenges = stats.challenges;
  const total = quizzes + challenges;

  if (total === 0) {
    return {
      id: 'recent-quiet',
      kind: 'momentum',
      icon: 'moon.stars.fill',
      tone: 'neutral',
      title: 'A quiet stretch',
      body: 'No quiz or challenge activity in the last week. Even one quick session keeps your insights sharp.',
      cta: { label: 'Take a quick quiz', deeplink: 'scaleup://my-plan' },
    };
  }

  let body;
  if (quizzes > 0) {
    const score = stats.avgScore != null ? `, averaging ${stats.avgScore}%` : '';
    const topic = stats.topTopic ? ` Most of it on ${_titleCase(stats.topTopic)}.` : '';
    body = `You completed ${quizzes} quiz${quizzes === 1 ? '' : 'zes'}${score} in the last ${window}.${topic}`;
  } else {
    body = `You took ${challenges} daily challenge${challenges === 1 ? '' : 's'} in the last ${window}. Quizzes give richer feedback — worth mixing in.`;
  }

  return {
    id: 'recent-activity',
    kind: 'momentum',
    icon: 'bolt.fill',
    tone: 'positive',
    title: `Last ${window}`,
    body,
    metric: stats.avgScore != null ? { label: 'avg score', value: `${stats.avgScore}%` } : null,
  };
}

function _objectiveCard(alignment, objective) {
  if (!alignment || !objective) return null;
  const goalLabel = _objectiveLabel(objective);

  if (!alignment.hasCompetencies) {
    return {
      id: 'objective-no-competencies',
      kind: 'objective',
      icon: 'target',
      tone: 'neutral',
      title: 'Where you\'re heading',
      body: `You\'re working toward ${goalLabel}. Your overall mastery is ${alignment.readinessPct ?? 0}% — keep going.`,
    };
  }

  const ready = alignment.readinessPct ?? 0;
  const delta = alignment.weekDelta;
  const daysToTarget = alignment.daysToTarget;
  let body = `You\'re ${ready}% of the way to ready for ${goalLabel}.`;
  if (delta != null && delta !== 0) {
    body += delta > 0
      ? ` Up ${delta} points this week — keep the rhythm.`
      : ` Down ${Math.abs(delta)} points this week — worth a focused session.`;
  }
  if (daysToTarget != null && daysToTarget > 0) {
    body += ` ${daysToTarget} day${daysToTarget === 1 ? '' : 's'} until your target date.`;
  }
  return {
    id: 'objective-progress',
    kind: 'objective',
    icon: 'target',
    tone: delta != null && delta < 0 ? 'caution' : 'positive',
    title: 'Where you\'re heading',
    body,
    metric: { label: 'readiness', value: `${ready}%`, delta: delta != null ? `${delta > 0 ? '+' : ''}${delta}pp this week` : null },
  };
}

function _attentionCard(signals) {
  // Priority: critical-stale-objective-linked > anomaly accuracy_drop > declining momentum > generic stale
  const blockers = signals.objectiveAlignment?.blockers || [];
  const criticalBlocker = blockers.find(b => b.daysSinceActivity != null && b.daysSinceActivity >= T.STALE_DAYS_CRITICAL);
  if (criticalBlocker) {
    return {
      id: `attention-stale-${_slug(criticalBlocker.competency)}`,
      kind: 'attention', icon: 'exclamationmark.triangle.fill', tone: 'caution',
      title: 'Worth your attention',
      body: `${_titleCase(criticalBlocker.competency)} hasn\'t been touched in ${criticalBlocker.daysSinceActivity} days — and it\'s on your goal path. 10 minutes today moves your readiness needle.`,
      cta: { label: `Practice ${_titleCase(criticalBlocker.competency)}`, deeplink: `scaleup://topic/${_slug(criticalBlocker.competency)}` },
    };
  }

  const anomaly = signals.anomalies[0];
  if (anomaly) {
    return {
      id: `attention-drop-${_slug(anomaly.topic)}`,
      kind: 'attention', icon: 'arrow.down.right.circle.fill',
      tone: anomaly.severity === 'high' ? 'caution' : 'neutral',
      title: 'Worth your attention',
      body: `Your ${_titleCase(anomaly.topic)} score has dropped ${Math.abs(anomaly.deltaPp)} points across your last ${anomaly.attempts} attempts (now ${anomaly.recentAvg}% vs ${anomaly.baseline}% baseline). A short focused session usually fixes this.`,
      metric: { label: 'recent avg', value: `${anomaly.recentAvg}%`, delta: `${anomaly.deltaPp}pp` },
      cta: { label: `Review ${_titleCase(anomaly.topic)}`, deeplink: `scaleup://topic/${_slug(anomaly.topic)}` },
    };
  }

  const declining = signals.momentum.declining[0];
  if (declining && declining.deltaPp != null) {
    return {
      id: `attention-declining-${_slug(declining.topic)}`,
      kind: 'attention', icon: 'arrow.down.right.circle.fill', tone: 'neutral',
      title: 'Worth your attention',
      body: `${_titleCase(declining.topic)} is trending down — recent attempts average ${declining.toScore}%, vs ${declining.fromScore}% earlier. Worth circling back before the gap grows.`,
      cta: { label: `Practice ${_titleCase(declining.topic)}`, deeplink: `scaleup://topic/${_slug(declining.topic)}` },
    };
  }

  const stale = signals.momentum.stale[0];
  if (stale) {
    return {
      id: `attention-stale-${_slug(stale.topic)}`,
      kind: 'attention', icon: 'clock.arrow.circlepath', tone: 'neutral',
      title: 'Worth your attention',
      body: `You haven\'t practiced ${_titleCase(stale.topic)} in ${stale.daysSinceActivity} days. Memory fades — a quick recall session locks it back in.`,
      cta: { label: `Refresh ${_titleCase(stale.topic)}`, deeplink: `scaleup://topic/${_slug(stale.topic)}` },
    };
  }

  // Positive default — nothing to flag
  const improving = signals.momentum.improving[0];
  if (improving && improving.deltaPp != null) {
    return {
      id: `attention-improving-${_slug(improving.topic)}`,
      kind: 'attention', icon: 'arrow.up.right.circle.fill', tone: 'positive',
      title: 'Strongest signal',
      body: `${_titleCase(improving.topic)} is your fastest-growing area: up ${improving.deltaPp} points across your recent attempts. Lean into it.`,
      metric: { label: 'recent avg', value: `${improving.toScore}%`, delta: `+${improving.deltaPp}pp` },
    };
  }

  return null;
}

function _milestoneCard(milestones) {
  if (!milestones?.length) return null;
  const recent = milestones.find(m => m.date && _daysBetween(m.date, new Date()) <= 1);
  if (!recent) return null;
  if (recent.type === 'level_up') {
    return {
      id: `milestone-level-${_slug(recent.topic)}`,
      kind: 'milestone', icon: 'star.fill', tone: 'celebration',
      title: 'Level up',
      body: `${_titleCase(recent.topic)} just moved from ${recent.from} to ${recent.to}. Real progress.`,
    };
  }
  if (recent.type === 'first_90_plus') {
    return {
      id: `milestone-90-${_slug(recent.topic)}`,
      kind: 'milestone', icon: 'star.fill', tone: 'celebration',
      title: 'Personal best',
      body: `You scored ${recent.score}% on ${_titleCase(recent.topic)} — your first 90+ on this topic. Nice.`,
    };
  }
  return null;
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function _objectiveSummary(objective, alignment) {
  if (!objective) return { hasObjective: false };
  return {
    hasObjective: true,
    objectiveType: objective.objectiveType,
    label: _objectiveLabel(objective),
    targetDate: objective.targetDate,
    daysToTarget: alignment?.daysToTarget ?? null,
    readinessPct: alignment?.readinessPct ?? null,
    weekDelta: alignment?.weekDelta ?? null,
  };
}

function _objectiveLabel(o) {
  const s = o.specifics || {};
  return s.examName || s.targetRole || s.targetSkill || o.objectiveType?.replace(/_/g, ' ') || 'your goal';
}

function _scoreToLevel(score) {
  if (score == null) return 'not_started';
  if (score >= 90) return 'expert';
  if (score >= 70) return 'advanced';
  if (score >= 40) return 'intermediate';
  if (score > 0)  return 'beginner';
  return 'not_started';
}

function _levelRank(level) {
  return ['not_started', 'beginner', 'intermediate', 'advanced', 'expert'].indexOf(level);
}

function _daysBetween(a, b) {
  const ms = Math.abs(new Date(b).getTime() - new Date(a).getTime());
  return ms / 86400000;
}

function _maxDate(dates) {
  const valid = dates.filter(Boolean).map(d => new Date(d).getTime());
  if (!valid.length) return null;
  return new Date(Math.max(...valid));
}

function _titleCase(s) {
  if (!s) return s;
  return s.replace(/\b([a-z])/g, (_, c) => c.toUpperCase());
}

function _slug(s) {
  return (s || '').toString().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

module.exports = {
  generateForUser,
  invalidate: _invalidate,
  // Exported for tests:
  _internal: {
    _classifyState, _computeSignals, _computeMomentum, _computeMilestones,
    _computeAnomalies, _computeObjectiveAlignment, _buildCards,
  },
};
