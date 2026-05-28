'use strict';

const Content = require('../../models/Content');
const CapstoneSession = require('../models/capstoneSession.model');
const ArtifactBundle = require('../models/artifactBundle.model');

/**
 * Capstone reflection note auto-generator (spec §10 — "Notes —
 * Auto-generates a learner reflection note after each Capstone").
 *
 * Creates a personal (status='draft', not published) Content document
 * with contentType='notes' that the learner can find under You → My
 * notes. The note bundles:
 *   - Capstone brief + difficulty + final score
 *   - Voice-reflection transcript
 *   - Top-3 strengths and top-3 gaps from the evaluator
 *   - Per-dimension rubric snapshot
 *
 * Idempotent: keyed on capstoneSessionId stored under metaTags. Calling
 * twice for the same session returns the existing note.
 */

const NOTE_TAG_PREFIX = 'capstone-reflection-session-';

async function ensureNoteForSession(sessionId) {
  const session = await CapstoneSession.findById(sessionId).lean();
  if (!session) return null;
  if (!session.voice_reflection_transcript) return null;
  if (!session.result) return null;

  const sessionTag = `${NOTE_TAG_PREFIX}${sessionId}`;

  // Idempotency check.
  const existing = await Content.findOne({
    creatorId: session.user_id,
    contentType: 'notes',
    topics: sessionTag,
  })
    .select('_id')
    .lean();
  if (existing) return existing._id;

  const bundle = await ArtifactBundle.findById(session.bundle_id).lean();

  const title = bundle
    ? `Capstone reflection — ${bundle.role_track.toUpperCase()} · ${cap(bundle.difficulty)}`
    : 'Capstone reflection';

  const body = buildNoteBody({ session, bundle });

  const doc = await Content.create({
    creatorId: session.user_id,
    title,
    description: body.slice(0, 5000),
    contentType: 'notes',
    // Personal note — store the markdown directly as the contentURL is a
    // required field by schema; we use a special data URL so the existing
    // notes UI renders it without needing an S3 fetch.
    contentURL: `data:text/markdown;base64,${Buffer.from(body, 'utf8').toString('base64')}`,
    status: 'draft',
    topics: [sessionTag, 'capstone-reflection', `role-track-${bundle?.role_track || 'unknown'}`],
  });

  return doc._id;
}

function buildNoteBody({ session, bundle }) {
  const dims = session.result?.dimension_scores || {};
  const lines = [
    `# Capstone reflection`,
    '',
    bundle ? `**Capstone:** ${bundle.brief.split('\n')[0]}` : '',
    bundle ? `**Difficulty:** ${cap(bundle.difficulty)} · **Track:** ${bundle.role_track.toUpperCase()} · **Language:** ${bundle.language}` : '',
    `**Overall score:** ${session.result?.overall_score ?? 0} / 100`,
    `**Integrity confidence:** ${cap(session.result?.integrity_confidence || 'unknown')}`,
    '',
    `## Where I landed`,
    '',
    `| Dimension | Score |`,
    `|---|---|`,
    `| Correctness | ${fmt(dims.correctness)} |`,
    `| Code quality | ${fmt(dims.code_quality)} |`,
    `| AI-pair effectiveness | ${fmt(dims.ai_pair_effectiveness)} |`,
    `| Verification discipline | ${fmt(dims.verification_discipline)} |`,
    `| Decomposition | ${fmt(dims.decomposition)} |`,
    `| Reflection quality | ${fmt(dims.reflection_quality)} |`,
    '',
  ];

  if (session.result?.strengths?.length) {
    lines.push(`## Strengths`, '');
    for (const s of session.result.strengths) lines.push(`- ${s}`);
    lines.push('');
  }
  if (session.result?.gaps?.length) {
    lines.push(`## Gaps to work on`, '');
    for (const g of session.result.gaps) lines.push(`- ${g}`);
    lines.push('');
  }

  if (session.voice_reflection_transcript) {
    lines.push(`## My reflection (voice transcript)`, '');
    lines.push(session.voice_reflection_transcript.trim());
    lines.push('');
  }

  if (session.result?.interview_parallel) {
    lines.push(`## Interview parallel`, '', session.result.interview_parallel, '');
  }

  return lines.filter((l) => l !== null).join('\n');
}

function cap(s) {
  if (!s) return '';
  return s[0].toUpperCase() + s.slice(1);
}

function fmt(n) {
  if (typeof n !== 'number') return '—';
  return `${n.toFixed(1)} / 10`;
}

module.exports = { ensureNoteForSession, NOTE_TAG_PREFIX };
