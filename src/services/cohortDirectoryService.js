const crypto = require('crypto');
const CohortDirectory = require('../models/CohortDirectory');
const { findBySlug } = require('../config/canonicalTopics');

const PERSONA_NAME_POOL = [
  'Aanya', 'Vikram', 'Priya', 'Rohan', 'Sneha', 'Karan', 'Meera', 'Arjun',
  'Diya', 'Ishaan', 'Ananya', 'Reyansh', 'Saanvi', 'Aarav', 'Anika', 'Kabir',
];

function _hash(s) {
  return crypto.createHash('sha256').update(s).digest();
}

function _seededInt(seedBuf, byteOffset, mod) {
  // Read 4 bytes as an unsigned int and mod down. byteOffset wraps.
  const i = seedBuf.readUInt32BE(byteOffset % (seedBuf.length - 4));
  return i % mod;
}

/**
 * Three stable personas per cohort. Names picked from a fixed pool with the
 * cohort-seeded index; offsets deterministic per persona slot.
 */
function generatePersonaGhosts(canonicalTopic) {
  const seedBuf = _hash(`persona:${canonicalTopic}`);
  // Three personas with distinct offsets: +8, +2, -5 from cohort median.
  const OFFSETS = [8, 2, -5];
  const picked = [];
  const used = new Set();
  let cursor = 0;
  for (let slot = 0; slot < 3; slot++) {
    let idx;
    do {
      idx = _seededInt(seedBuf, cursor, PERSONA_NAME_POOL.length);
      cursor = (cursor + 4) % (seedBuf.length - 4);
    } while (used.has(idx));
    used.add(idx);
    picked.push({
      name: PERSONA_NAME_POOL[idx],
      medianOffset: OFFSETS[slot],
      seed: `${canonicalTopic}:${slot}`,
    });
  }
  return picked;
}

/**
 * Deterministic per-(persona, week) score. Same persona drifts ±5 within a
 * plausible band week over week so the user sees stable competitors slowly
 * shifting position.
 */
function personaScoreForWeek(persona, weekStart, cohortMedian) {
  const week = new Date(weekStart).toISOString().slice(0, 10);
  const buf = _hash(`${persona.seed}:${week}`);
  // Jitter in range [-5, +5].
  const jitter = (buf.readUInt8(0) % 11) - 5;
  return Math.max(0, Math.round(cohortMedian + persona.medianOffset + jitter));
}

/**
 * Upsert a cohort directory entry on objective save. Idempotent.
 * memberCount is incremented only when a new (userId, canonicalTopic) link
 * is being established; the caller is responsible for that contract.
 */
async function recordMemberJoin(canonicalTopic, objectiveType) {
  const meta = findBySlug(canonicalTopic);
  const update = {
    $setOnInsert: {
      canonicalTopic,
      displayName: meta?.display || canonicalTopic,
      personaGhosts: generatePersonaGhosts(canonicalTopic),
    },
    $addToSet: { objectiveTypes: objectiveType },
    $inc: { memberCount: 1 },
    $set: { isActive: true },
  };
  return CohortDirectory.findOneAndUpdate(
    { canonicalTopic },
    update,
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function recordMemberLeave(canonicalTopic) {
  const doc = await CohortDirectory.findOne({ canonicalTopic });
  if (!doc) return null;
  doc.memberCount = Math.max(0, (doc.memberCount || 0) - 1);
  return doc.save();
}

async function recordAttempt(canonicalTopic) {
  return CohortDirectory.findOneAndUpdate(
    { canonicalTopic },
    { $inc: { weeklyAttempts: 1 }, $set: { lastAttemptAt: new Date() } },
    { new: true }
  );
}

async function markChallengeGenerated(canonicalTopic, date) {
  return CohortDirectory.findOneAndUpdate(
    { canonicalTopic },
    { $set: { lastChallengeDate: date } },
    { new: true }
  );
}

module.exports = {
  recordMemberJoin,
  recordMemberLeave,
  recordAttempt,
  markChallengeGenerated,
  _internal: { generatePersonaGhosts, personaScoreForWeek },
};
