'use strict';

/**
 * assessmentSpecService.js
 *
 * Turns a TPO's free-text brief ("give my final-year CS cohort a 45-minute
 * technical interview on system design") into a VALID create-assessment
 * payload — the same shape assessmentService.createAssessment already
 * accepts (src/services/institution/assessment/assessmentService.js, the
 * E2 per-type config validation) and that the Assessment schema
 * (src/models/Assessment.js `config.<type>`) stores.
 *
 * ONE LLM call (aiProvider.analyzeWithClaude — strict JSON, throws on
 * non-JSON per its own contract) asks the model to pick exactly one engine
 * (`type` in mcq|capstone|interview|drill) and fill ONLY that engine's
 * config block. validateSpec() then repairs the model's answer
 * deterministically against the SAME enums/requirements createAssessment
 * enforces, so by the time a spec reaches createAssessment it is guaranteed
 * well-formed — never a BAD_CONFIG surprise from a model hallucination.
 * Only when a requirement has no safe deterministic default (no
 * recognizable drillSubtype; a `type` that can't be resolved at all) does
 * validateSpec throw `Error('could not understand the brief')`.
 */

const VALID_TYPES = ['mcq', 'capstone', 'interview', 'drill'];
const VALID_ROLE_TRACKS = ['swe', 'ds', 'ai_eng'];
const VALID_DIFFICULTIES = ['easy', 'medium', 'hard'];
const VALID_DRILL_SUBTYPES = ['prompt', 'verify', 'decompose', 'refactor'];
const VALID_INTERVIEW_TYPES = ['placement_hr', 'placement_technical', 'behavioral', 'technical'];

// Aliases the model might reasonably use instead of the exact enum token —
// coerced to the nearest valid value rather than rejected outright.
const ROLE_TRACK_ALIASES = {
  swe: 'swe', software: 'swe', fullstack: 'swe', 'full-stack': 'swe', 'full stack': 'swe',
  backend: 'swe', 'back-end': 'swe', frontend: 'swe', 'front-end': 'swe', web: 'swe', engineering: 'swe',
  ds: 'ds', data: 'ds', 'data science': 'ds', 'data scientist': 'ds', 'data-science': 'ds', analytics: 'ds',
  ai_eng: 'ai_eng', ai: 'ai_eng', ml: 'ai_eng', 'machine learning': 'ai_eng', 'machine-learning': 'ai_eng',
  'ai engineering': 'ai_eng', 'ai engineer': 'ai_eng', 'ai_engineer': 'ai_eng', genai: 'ai_eng', 'gen ai': 'ai_eng',
};

const DRILL_SUBTYPE_ALIASES = {
  prompt: 'prompt', prompting: 'prompt', 'prompt engineering': 'prompt', 'prompt-engineering': 'prompt',
  verify: 'verify', verification: 'verify', 'bug hunt': 'verify', 'bug-hunt': 'verify',
  'bug hunting': 'verify', 'bug-hunting': 'verify', debugging: 'verify', debug: 'verify', review: 'verify',
  decompose: 'decompose', decomposition: 'decompose', breakdown: 'decompose', planning: 'decompose',
  refactor: 'refactor', refactoring: 'refactor', cleanup: 'refactor', 'code quality': 'refactor', 'code-quality': 'refactor',
};

// ── small deterministic coercion helpers ────────────────────────────────────

function clampInt(value, { min = 1, max = Infinity, fallback }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  if (rounded < min) return fallback;
  return Math.min(rounded, max);
}

function cleanString(value, { maxLen = 500 } = {}) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.slice(0, maxLen);
}

function coerceRoleTrack(value) {
  if (VALID_ROLE_TRACKS.includes(value)) return value;
  const key = cleanString(value).toLowerCase();
  return ROLE_TRACK_ALIASES[key] || null;
}

function coerceDifficulty(value, fallback = 'medium') {
  const v = cleanString(value).toLowerCase();
  return VALID_DIFFICULTIES.includes(v) ? v : fallback;
}

function coerceDrillSubtype(value) {
  if (VALID_DRILL_SUBTYPES.includes(value)) return value;
  const key = cleanString(value).toLowerCase();
  return DRILL_SUBTYPE_ALIASES[key] || null;
}

function deriveTitle(raw, fallback) {
  const cleaned = cleanString(raw, { maxLen: 120 });
  return cleaned || fallback;
}

// ── per-engine repairers ─────────────────────────────────────────────────────
// Each returns a valid config.<type> object, or throws
// Error('could not understand the brief') only when no deterministic default
// can safely satisfy createAssessment's requirement for that engine.

function repairMcq(raw, title) {
  const src = raw || {};
  const questionCount = clampInt(src.questionCount, { min: 1, max: 100, fallback: 20 });
  const defaultTotal = Math.min(30, Math.ceil(questionCount * 1.5));
  let totalQuestions = clampInt(src.totalQuestions, { min: 1, max: 30, fallback: defaultTotal });
  if (totalQuestions < questionCount) totalQuestions = defaultTotal;
  const durationSeconds = clampInt(src.durationSeconds, { min: 60, max: 24 * 3600, fallback: 1800 });
  const assessmentType = cleanString(src.assessmentType, { maxLen: 30 }) || 'mixed';
  // A clean, human topic label — never the whole brief. Anything implausibly
  // long is treated as a prompt-stuffed blob and discarded in favour of title.
  let topic = cleanString(src.topic, { maxLen: 150 });
  if (!topic) topic = title;
  return { questionCount, totalQuestions, durationSeconds, assessmentType, topic };
}

function repairCapstone(raw, brief) {
  const src = raw || {};
  const difficulty = coerceDifficulty(src.difficulty);
  const durationSeconds = clampInt(src.durationSeconds, { min: 300, max: 8 * 3600, fallback: 5400 });
  const roleTrack = coerceRoleTrack(src.roleTrack);
  const bundleId = cleanString(src.bundleId, { maxLen: 64 }) || undefined;
  const topicHint = cleanString(src.topicHint, { maxLen: 300 }) || undefined;
  let jobDescription = cleanString(src.jobDescription, { maxLen: 4000 });

  const out = { difficulty, durationSeconds };
  if (roleTrack) out.roleTrack = roleTrack;
  if (bundleId) out.bundleId = bundleId;
  if (topicHint) out.topicHint = topicHint;

  // createAssessment requires at least one of bundleId|roleTrack|jobDescription —
  // synthesize a jobDescription from the brief so a role-implying brief is
  // always satisfiable even when the model omitted everything else. Only the
  // BRIEF is trustworthy enough to synthesize from here — falling back to the
  // (possibly generic, e.g. "Untitled Assessment") title would fabricate a
  // jobDescription with no real content behind it.
  if (!out.bundleId && !out.roleTrack && !jobDescription) {
    const synthesized = cleanString(brief, { maxLen: 4000 });
    if (synthesized) jobDescription = synthesized;
  }
  if (jobDescription) out.jobDescription = jobDescription;

  if (!out.bundleId && !out.roleTrack && !out.jobDescription) {
    throw new Error('could not understand the brief');
  }
  return out;
}

function repairInterview(raw, title) {
  const src = raw || {};
  const targetRole = cleanString(src.targetRole, { maxLen: 150 });
  let interviewType = cleanString(src.interviewType, { maxLen: 40 });
  if (!VALID_INTERVIEW_TYPES.includes(interviewType)) {
    // No safe way to guess HR vs technical from nothing — lean technical when
    // a role was named (the common case), HR otherwise.
    interviewType = targetRole ? 'placement_technical' : 'placement_hr';
  }
  const difficulty = cleanString(src.difficulty, { maxLen: 20 }) || 'moderate';
  const durationSeconds = clampInt(src.durationSeconds, { min: 300, max: 4 * 3600, fallback: 1800 });
  const targetCompany = cleanString(src.targetCompany, { maxLen: 100 }) || undefined;

  const out = { interviewType, targetRole: targetRole || title, difficulty, durationSeconds };
  if (targetCompany) out.targetCompany = targetCompany;
  return out;
}

function repairDrill(raw) {
  const src = raw || {};
  const drillSubtype = coerceDrillSubtype(src.drillSubtype);
  if (!drillSubtype) throw new Error('could not understand the brief');
  const roleTrack = coerceRoleTrack(src.roleTrack) || 'swe';
  const difficulty = coerceDifficulty(src.difficulty);
  return { drillSubtype, roleTrack, difficulty };
}

/**
 * validateSpec(spec) -> repaired spec
 *
 * spec (loose, model-shaped input allowed): { type, title, brief?,
 *   config: { mcq?, capstone?, interview?, drill? }, opensAt?, closesAt? }
 *
 * Returns a spec matching createAssessment's payload shape exactly:
 *   { type, title, config: { [type]: {...} }, opensAt?, closesAt? }
 *
 * Throws Error('could not understand the brief') when `type` can't be
 * resolved to one of the four engines at all, or a per-type requirement has
 * no safe deterministic default (drill with no recognizable drillSubtype;
 * capstone with nothing to build bundleId/roleTrack/jobDescription from).
 */
function validateSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('could not understand the brief');

  const cfgIn = (spec.config && typeof spec.config === 'object') ? spec.config : {};

  let type = VALID_TYPES.includes(spec.type) ? spec.type : null;
  if (!type) {
    // Best-effort recovery: infer from whichever per-type block actually has content.
    type = VALID_TYPES.find((t) => cfgIn[t] && typeof cfgIn[t] === 'object' && Object.keys(cfgIn[t]).length > 0) || null;
  }
  if (!type) throw new Error('could not understand the brief');

  const title = deriveTitle(spec.title, deriveTitle(spec.brief, 'Untitled Assessment'));

  let config;
  if (type === 'mcq') config = { mcq: repairMcq(cfgIn.mcq, title) };
  else if (type === 'capstone') config = { capstone: repairCapstone(cfgIn.capstone, spec.brief) };
  else if (type === 'interview') config = { interview: repairInterview(cfgIn.interview, title) };
  else config = { drill: repairDrill(cfgIn.drill) };

  const out = { type, title, config };

  // Window: only carry through when both sides parse to valid, correctly-ordered dates.
  if (spec.opensAt && spec.closesAt) {
    const o = new Date(spec.opensAt);
    const c = new Date(spec.closesAt);
    if (!Number.isNaN(o.getTime()) && !Number.isNaN(c.getTime()) && o < c) {
      out.opensAt = o;
      out.closesAt = c;
    }
  }

  return out;
}

// ── parseBrief — one LLM call -> validated spec ──────────────────────────────

function buildPrompt(brief, cohortLabel) {
  const systemPrompt = [
    "You are an assessment-design assistant for a campus placement platform.",
    "A placement officer (TPO) describes, in free text, the assessment they want for a cohort.",
    "Your job: pick EXACTLY ONE assessment engine and fill ONLY that engine's config block.",
    '',
    'Available engines:',
    '- "mcq": multiple-choice knowledge/aptitude test.',
    '- "capstone": a multi-hour coding project (build/extend a small system).',
    '- "interview": a simulated interview (HR or technical).',
    '- "drill": a short, focused coding exercise (single skill, tens of minutes).',
    '',
    'Return ONLY a single JSON object, no prose, matching exactly this shape:',
    '{',
    '  "type": "mcq" | "capstone" | "interview" | "drill",',
    '  "title": "short human title for the assessment, <= 80 chars",',
    '  "mcq": { "topic": "clean human topic label, e.g. \'Quantitative Aptitude — arithmetic, ratios, data interpretation\'", "questionCount": 20, "totalQuestions": 30, "durationSeconds": 1800, "assessmentType": "mixed" },',
    '  "capstone": { "roleTrack": "swe|ds|ai_eng", "jobDescription": "1-3 sentence project brief synthesized from the TPO brief", "difficulty": "easy|medium|hard", "durationSeconds": 5400, "topicHint": "optional short hint" },',
    '  "interview": { "interviewType": "placement_hr|placement_technical", "targetRole": "role being interviewed for", "targetCompany": "optional company name", "difficulty": "easy|moderate|hard", "durationSeconds": 1800 },',
    '  "drill": { "drillSubtype": "prompt|verify|decompose|refactor", "roleTrack": "swe|ds|ai_eng", "difficulty": "easy|medium|hard" }',
    '}',
    '',
    'Fill in ONLY the block matching the chosen "type" with realistic values inferred from the brief.',
    'Omit the other three blocks, or leave them empty — they are ignored.',
    '"mcq.topic" must be a short, clean, human-readable topic label — never restate the whole brief.',
    'Return ONLY valid JSON. No markdown fences, no commentary.',
  ].join('\n');

  const userPrompt = [
    `Cohort: ${cohortLabel || 'this cohort'}`,
    `TPO brief: "${brief}"`,
  ].join('\n');

  return { systemPrompt, userPrompt };
}

/**
 * parseBrief({ brief, cohortLabel }, deps) -> Promise<{ type, title, config, opensAt?, closesAt? }>
 *
 * ONE LLM call via aiProvider.analyzeWithClaude (strict JSON — it throws on
 * a non-JSON response itself). Throws Error('could not understand the
 * brief') when the brief is empty/unusable, the LLM call fails, or the
 * model's answer can't be repaired into a valid spec by validateSpec.
 */
async function parseBrief({ brief, cohortLabel } = {}, deps = {}) {
  const cleanBrief = cleanString(brief, { maxLen: 4000 });
  if (!cleanBrief) throw new Error('could not understand the brief');

  const aiProvider = deps.aiProvider || require('../../../config/aiProvider');
  const { systemPrompt, userPrompt } = buildPrompt(cleanBrief, cohortLabel);

  let raw;
  try {
    raw = await aiProvider.analyzeWithClaude({ systemPrompt, userPrompt, temperature: 0.3, maxTokens: 1500 });
  } catch (_err) {
    throw new Error('could not understand the brief');
  }
  if (!raw || typeof raw !== 'object') throw new Error('could not understand the brief');

  return validateSpec({
    type: raw.type,
    title: raw.title,
    brief: cleanBrief,
    config: { mcq: raw.mcq, capstone: raw.capstone, interview: raw.interview, drill: raw.drill },
    opensAt: raw.opensAt,
    closesAt: raw.closesAt,
  });
}

module.exports = {
  parseBrief,
  validateSpec,
  _helpers: { coerceRoleTrack, coerceDrillSubtype, coerceDifficulty, clampInt, cleanString, deriveTitle },
};
