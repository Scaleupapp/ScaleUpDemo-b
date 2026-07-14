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
 *
 * Objective grounding (cohort's ObjectiveTemplate, when the cohort has one):
 * authorAgentService.createAndAuthor resolves the cohort's objectiveTemplateId
 * -> ObjectiveTemplate and passes a compact `objective` context
 * ({ label, targetRole, targetCompany, targetSkill, competencies }) into
 * parseBrief. That context is (a) injected into the LLM prompt as
 * AUTHORITATIVE CONTEXT the model should design around unless the brief
 * explicitly overrides it, and (b) used as a DETERMINISTIC fallback —
 * roleTrackFromObjective()/resolveRoleTrack() for drill's roleTrack, and the
 * objective's targetRole/targetCompany for interview specs — whenever the
 * brief itself is silent. Precedence (documented again at resolveRoleTrack):
 * explicit brief > LLM-chosen from brief > objective-derived > 'swe' default.
 * Every spec returns `groundedIn: { objective, roleTrackSource,
 * targetRoleSource }` so the provenance is honest and visible to the UI —
 * this is never persisted onto the Assessment doc (not in its schema); it's
 * a response-only field.
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

// ── objective-derived roleTrack fallback ────────────────────────────────────
//
// Keyword map from an ObjectiveTemplate's targetRole/targetSkill text to one
// of the three roleTrack enum values. Order matters: AI/LLM/GenAI engineering
// roles are checked BEFORE the broader data/analytics bucket, since a role
// like "ML Engineer" would otherwise also match the data keywords below.
// Anything that names a role/skill at all but matches neither bucket is
// treated as a general engineering role ('swe') — only a completely absent
// targetRole/targetSkill yields "no signal" (null).
const OBJECTIVE_ROLE_TRACK_RULES = [
  {
    track: 'ai_eng',
    pattern: /\b(ai|artificial[\s-]?intelligence|llm|genai|gen[\s-]?ai|generative[\s-]?ai|prompt engineer(?:ing)?|ml engineer|machine[\s-]?learning engineer)\b/i,
  },
  {
    track: 'ds',
    pattern: /\b(data scientist|data science|data analyst|analytics|analyst|machine[\s-]?learning|ml)\b/i,
  },
];

/**
 * roleTrackFromObjective(objective) -> 'swe' | 'ds' | 'ai_eng' | null
 *
 * null means the objective gave no targetRole/targetSkill text to derive
 * anything from (no objective at all, or an objective with neither field
 * set) — the caller should fall through to the next precedence tier, not
 * treat null as 'swe'.
 */
function roleTrackFromObjective(objective) {
  if (!objective) return null;
  const text = [objective.targetRole, objective.targetSkill].filter(Boolean).join(' ').trim();
  if (!text) return null;
  for (const rule of OBJECTIVE_ROLE_TRACK_RULES) {
    if (rule.pattern.test(text)) return rule.track;
  }
  return 'swe';
}

/**
 * resolveRoleTrack(rawValue, objective) -> { roleTrack, source }
 *
 * The roleTrack precedence used everywhere a roleTrack must be resolved:
 *   1. explicit brief / LLM-chosen from brief — `rawValue` is whatever the
 *      LLM put in the per-engine config block for this brief (which itself
 *      reflects an explicit brief statement when there was one); coerced
 *      through the same alias table brief-only resolution always used.
 *   2. objective-derived — roleTrackFromObjective() when (1) yields nothing.
 *   3. 'swe' default — only when neither the brief nor the objective gave
 *      any signal. This REPLACES the old blind `|| 'swe'` that ignored the
 *      cohort's objective entirely.
 */
function resolveRoleTrack(rawValue, objective) {
  const fromBrief = coerceRoleTrack(rawValue);
  if (fromBrief) return { roleTrack: fromBrief, source: 'brief' };
  const fromObjective = roleTrackFromObjective(objective);
  if (fromObjective) return { roleTrack: fromObjective, source: 'objective' };
  return { roleTrack: 'swe', source: 'default' };
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

/**
 * repairInterview(raw, title, objective) -> { config, targetRoleSource }
 *
 * targetRole/targetCompany precedence: explicit brief (the LLM's parse of
 * it) > the cohort's objective > (targetRole only) the derived title as a
 * last resort. targetRoleSource is 'brief' | 'objective' | null — null
 * means neither the brief nor the objective named a role, so targetRole
 * fell back to the assessment title (not a real signal worth reporting).
 */
function repairInterview(raw, title, objective) {
  const src = raw || {};
  let targetRoleSource = null;
  let targetRole = cleanString(src.targetRole, { maxLen: 150 });
  if (targetRole) {
    targetRoleSource = 'brief';
  } else if (objective && objective.targetRole) {
    const fromObjective = cleanString(objective.targetRole, { maxLen: 150 });
    if (fromObjective) {
      targetRole = fromObjective;
      targetRoleSource = 'objective';
    }
  }

  let interviewType = cleanString(src.interviewType, { maxLen: 40 });
  if (!VALID_INTERVIEW_TYPES.includes(interviewType)) {
    // No safe way to guess HR vs technical from nothing — lean technical when
    // a role was named (the common case), HR otherwise.
    interviewType = targetRole ? 'placement_technical' : 'placement_hr';
  }
  const difficulty = cleanString(src.difficulty, { maxLen: 20 }) || 'moderate';
  const durationSeconds = clampInt(src.durationSeconds, { min: 300, max: 4 * 3600, fallback: 1800 });

  let targetCompany = cleanString(src.targetCompany, { maxLen: 100 }) || undefined;
  if (!targetCompany && objective && objective.targetCompany) {
    targetCompany = cleanString(objective.targetCompany, { maxLen: 100 }) || undefined;
  }

  const config = { interviewType, targetRole: targetRole || title, difficulty, durationSeconds };
  if (targetCompany) config.targetCompany = targetCompany;
  return { config, targetRoleSource };
}

/**
 * repairDrill(raw, objective) -> { config, roleTrackSource }
 *
 * roleTrack resolution goes through resolveRoleTrack() — see its doc comment
 * for the full explicit-brief > LLM-chosen-from-brief > objective-derived >
 * 'swe' precedence. This replaces the old blind `coerceRoleTrack(...) ||
 * 'swe'`, which threw the cohort's objective away entirely.
 */
function repairDrill(raw, objective) {
  const src = raw || {};
  const drillSubtype = coerceDrillSubtype(src.drillSubtype);
  if (!drillSubtype) throw new Error('could not understand the brief');
  const { roleTrack, source: roleTrackSource } = resolveRoleTrack(src.roleTrack, objective);
  const difficulty = coerceDifficulty(src.difficulty);
  return { config: { drillSubtype, roleTrack, difficulty }, roleTrackSource };
}

/**
 * validateSpec(spec, objective?) -> repaired spec
 *
 * spec (loose, model-shaped input allowed): { type, title, brief?,
 *   config: { mcq?, capstone?, interview?, drill? }, opensAt?, closesAt? }
 * objective (optional): the cohort's grounding context — see the file-level
 * doc comment and resolveRoleTrack()/repairInterview() for how it's used.
 *
 * Returns a spec matching createAssessment's payload shape exactly, PLUS a
 * response-only `groundedIn` provenance field (never fed into
 * createAssessment — it's not in the Assessment schema):
 *   { type, title, config: { [type]: {...} }, opensAt?, closesAt?,
 *     groundedIn: { objective: label|null, roleTrackSource, targetRoleSource } }
 *
 * Throws Error('could not understand the brief') when `type` can't be
 * resolved to one of the four engines at all, or a per-type requirement has
 * no safe deterministic default (drill with no recognizable drillSubtype;
 * capstone with nothing to build bundleId/roleTrack/jobDescription from).
 */
function validateSpec(spec, objective) {
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
  let roleTrackSource = null;
  let targetRoleSource = null;

  if (type === 'mcq') {
    config = { mcq: repairMcq(cfgIn.mcq, title) };
  } else if (type === 'capstone') {
    config = { capstone: repairCapstone(cfgIn.capstone, spec.brief) };
  } else if (type === 'interview') {
    const repaired = repairInterview(cfgIn.interview, title, objective);
    config = { interview: repaired.config };
    targetRoleSource = repaired.targetRoleSource;
  } else {
    const repaired = repairDrill(cfgIn.drill, objective);
    config = { drill: repaired.config };
    roleTrackSource = repaired.roleTrackSource;
  }

  // mcq/interview carry no roleTrack of their own, and capstone's roleTrack
  // is optional and left untouched by repairCapstone above — for all three,
  // still report (informationally, without mutating config) what roleTrack
  // this cohort's objective would resolve to, so groundedIn is always a
  // complete, honest signal rather than silently blank for those engines.
  if (!roleTrackSource) {
    const rawRoleTrack = type === 'capstone' && cfgIn.capstone ? cfgIn.capstone.roleTrack : undefined;
    roleTrackSource = resolveRoleTrack(rawRoleTrack, objective).source;
  }

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

  out.groundedIn = {
    objective: (objective && objective.label) || null,
    roleTrackSource,
    targetRoleSource,
  };

  return out;
}

// ── parseBrief — one LLM call -> validated spec ──────────────────────────────

/**
 * buildObjectiveContextLine(objective) -> string | null
 *
 * A single AUTHORITATIVE CONTEXT line injected into the user prompt when the
 * cohort has an ObjectiveTemplate. null when there's no objective (or it has
 * no label) — the prompt then falls back to the pre-existing brief-only shape.
 */
function buildObjectiveContextLine(objective) {
  if (!objective || !objective.label) return null;

  const parts = [];
  if (objective.targetRole) parts.push(`target role: ${objective.targetRole}`);
  if (objective.targetCompany) parts.push(`target company: ${objective.targetCompany}`);
  if (objective.targetSkill) parts.push(`target skill: ${objective.targetSkill}`);
  if (Array.isArray(objective.competencies) && objective.competencies.length) {
    const names = objective.competencies
      .slice()
      .sort((a, b) => (b.weight || 0) - (a.weight || 0))
      .map((c) => c && c.name)
      .filter(Boolean)
      .slice(0, 6);
    if (names.length) parts.push(`key competencies: ${names.join(', ')}`);
  }
  const detail = parts.length ? ` (${parts.join('; ')})` : '';

  return (
    `AUTHORITATIVE CONTEXT: This cohort is preparing for: ${objective.label}${detail}. ` +
    'Ground the assessment in that objective — the role, topics and competencies should serve it — ' +
    'UNLESS the brief explicitly asks for something different, in which case the brief wins.'
  );
}

function buildPrompt(brief, cohortLabel, objective) {
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

  const userPromptLines = [`Cohort: ${cohortLabel || 'this cohort'}`];
  const objectiveLine = buildObjectiveContextLine(objective);
  if (objectiveLine) userPromptLines.push(objectiveLine);
  userPromptLines.push(`TPO brief: "${brief}"`);

  return { systemPrompt, userPrompt: userPromptLines.join('\n') };
}

/**
 * parseBrief({ brief, cohortLabel, objective }, deps)
 *   -> Promise<{ type, title, config, opensAt?, closesAt?, groundedIn }>
 *
 * ONE LLM call via aiProvider.analyzeWithClaude (strict JSON — it throws on
 * a non-JSON response itself). Throws Error('could not understand the
 * brief') when the brief is empty/unusable, the LLM call fails, or the
 * model's answer can't be repaired into a valid spec by validateSpec.
 *
 * `objective` (optional): the cohort's grounding context built by
 * authorAgentService.createAndAuthor from its ObjectiveTemplate — injected
 * into the prompt as authoritative context AND used as validateSpec's
 * deterministic fallback. See the file-level doc comment.
 */
async function parseBrief({ brief, cohortLabel, objective } = {}, deps = {}) {
  const cleanBrief = cleanString(brief, { maxLen: 4000 });
  if (!cleanBrief) throw new Error('could not understand the brief');

  const aiProvider = deps.aiProvider || require('../../../config/aiProvider');
  const { systemPrompt, userPrompt } = buildPrompt(cleanBrief, cohortLabel, objective);

  let raw;
  try {
    raw = await aiProvider.analyzeWithClaude({ systemPrompt, userPrompt, temperature: 0.3, maxTokens: 1500 });
  } catch (_err) {
    throw new Error('could not understand the brief');
  }
  if (!raw || typeof raw !== 'object') throw new Error('could not understand the brief');

  return validateSpec(
    {
      type: raw.type,
      title: raw.title,
      brief: cleanBrief,
      config: { mcq: raw.mcq, capstone: raw.capstone, interview: raw.interview, drill: raw.drill },
      opensAt: raw.opensAt,
      closesAt: raw.closesAt,
    },
    objective
  );
}

module.exports = {
  parseBrief,
  validateSpec,
  _helpers: {
    coerceRoleTrack,
    coerceDrillSubtype,
    coerceDifficulty,
    clampInt,
    cleanString,
    deriveTitle,
    roleTrackFromObjective,
    resolveRoleTrack,
  },
};
