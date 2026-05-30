'use strict';

/**
 * Public coding-profile sharing (recruiter view).
 *
 * Authed:
 *   POST   /api/coding/capstones/share          create a share token
 *   GET    /api/coding/capstones/share          list my active tokens
 *   DELETE /api/coding/capstones/share/:tokenId  revoke one
 *
 * Public (NO auth — mounted under /api/coding/public):
 *   GET    /api/coding/public/profiles/:token    scores + competency, no code
 *
 * The public projection is deliberately narrow: name (first name only),
 * role track, aggregate stats, and per-capstone score + difficulty + title.
 * No code, no full briefs, no email, no session internals.
 */

const ShareToken = require('../models/shareToken.model');
const CapstoneSession = require('../models/capstoneSession.model');
const ArtifactBundle = require('../models/artifactBundle.model');
const MetaSkillMastery = require('../models/metaSkillMastery.model');
const DifficultyState = require('../models/difficultyState.model');

const PUBLIC_BASE = process.env.PUBLIC_WEB_URL || 'https://scaleup-web-seven.vercel.app';

/** POST /share — create a token. Body: { label? } */
async function createShare(req, res) {
  const label = String(req.body?.label || '').slice(0, 60);
  const token = ShareToken.mintToken();
  const doc = await ShareToken.create({ user_id: req.user.userId, token, label });
  res.status(201).json({
    token: doc.token,
    label: doc.label,
    public_url: `${PUBLIC_BASE}/profile/${doc.token}`,
    created_at: doc.createdAt,
  });
}

/** GET /share — list my active (non-revoked) tokens. */
async function listShares(req, res) {
  const docs = await ShareToken.find({ user_id: req.user.userId, is_revoked: false })
    .sort({ createdAt: -1 })
    .lean();
  res.json({
    shares: docs.map((d) => ({
      token_id: String(d._id),
      token: d.token,
      label: d.label,
      public_url: `${PUBLIC_BASE}/profile/${d.token}`,
      view_count: d.view_count || 0,
      last_viewed_at: d.last_viewed_at,
      created_at: d.createdAt,
    })),
  });
}

/** DELETE /share/:tokenId — revoke. Idempotent. */
async function revokeShare(req, res) {
  await ShareToken.updateOne(
    { _id: req.params.tokenId, user_id: req.user.userId },
    { $set: { is_revoked: true } }
  );
  res.json({ revoked: true });
}

/**
 * GET /public/profiles/:token — UNAUTHENTICATED.
 * Returns the scores-and-competency-only public profile, or 404 for an
 * invalid / revoked / expired token (never reveal which).
 */
async function getPublicProfile(req, res) {
  const token = req.params.token;
  const share = await ShareToken.findOne({ token, is_revoked: false }).lean();
  if (!share) return res.status(404).json({ error: 'not_found' });
  if (share.expires_at && new Date(share.expires_at) < new Date()) {
    return res.status(404).json({ error: 'not_found' });
  }

  const userId = share.user_id;

  // Resolve identity (first name only) + role track without leaking PII.
  let firstName = 'A ScaleUp learner';
  try {
    const User = require('../../models/User');
    const u = await User.findById(userId).select('firstName name username').lean();
    firstName = (u?.firstName || (u?.name ? String(u.name).split(' ')[0] : null) || u?.username || firstName);
  } catch { /* keep default */ }

  const graded = await CapstoneSession.find({ user_id: userId, status: 'graded' })
    .sort({ graded_at: -1 })
    .limit(10)
    .populate('bundle_id', 'brief difficulty role_track')
    .lean();

  const scores = graded.map((s) => s.result?.overall_score).filter((n) => typeof n === 'number');
  const best = scores.length ? Math.max(...scores) : null;
  const mean = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;

  // Role track + mastery snapshot (per the most-attempted track).
  const trackCounts = {};
  for (const s of graded) {
    const rt = s.bundle_id?.role_track;
    if (rt) trackCounts[rt] = (trackCounts[rt] || 0) + 1;
  }
  const roleTrack = Object.keys(trackCounts).sort((a, b) => trackCounts[b] - trackCounts[a])[0] || null;

  let mastery = null;
  let currentDifficulty = null;
  if (roleTrack) {
    const [m, ds] = await Promise.all([
      MetaSkillMastery.findOne({ user_id: userId, role_track: roleTrack }).lean(),
      DifficultyState.findOne({ user_id: userId, role_track: roleTrack }).lean(),
    ]);
    if (m) {
      mastery = {
        prompting: round1(m.prompting?.level ?? 0),
        verification: round1(m.verification?.level ?? 0),
        decomposition: round1(m.decomposition?.level ?? 0),
        refactoring: round1(m.refactoring?.level ?? 0),
      };
    }
    currentDifficulty = ds?.current_difficulty || null;
  }

  // Best-effort view counter (don't block the response).
  ShareToken.updateOne(
    { _id: share._id },
    { $inc: { view_count: 1 }, $set: { last_viewed_at: new Date() } }
  ).catch(() => {});

  res.json({
    name: firstName,
    role_track: roleTrack,
    current_difficulty: currentDifficulty,
    total_capstones: scores.length,
    best_score: best,
    mean_score: mean,
    mastery, // 4 axes 0-10, or null
    capstones: graded.map((s) => ({
      // Title only — NOT the full brief, NOT the code.
      title: titleFromBrief(s.bundle_id?.brief),
      difficulty: s.bundle_id?.difficulty || null,
      overall_score: s.result?.overall_score ?? null,
      integrity_confidence: s.result?.integrity_confidence || null,
      graded_at: s.graded_at,
    })),
    generated_at: new Date(),
  });
}

function titleFromBrief(brief) {
  if (!brief) return 'Coding capstone';
  // First line, trimmed — the human title. Never the full spec.
  const first = String(brief).split('\n')[0].trim();
  return first.length > 90 ? first.slice(0, 90) + '…' : first;
}

function round1(n) {
  return Math.round(Number(n || 0) * 10) / 10;
}

module.exports = { createShare, listShares, revokeShare, getPublicProfile };
