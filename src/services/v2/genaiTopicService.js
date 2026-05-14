/**
 * GenAI Topic Service (v2)
 *
 * Every objective's topic list gets exactly ONE Generative-AI topic — but its
 * name and description are CONTEXTUALIZED to how GenAI complements that
 * specific objective. A CAT aspirant and an entrepreneur both get a GenAI
 * topic, but they are genuinely different topics.
 *
 * v2-isolated: this does NOT modify v1's topicTaxonomyService. The v2
 * onboarding flow calls this and injects the topic into the list AFTER
 * fetching the base taxonomy from TopicTaxonomy — so v1's behavior is
 * completely untouched.
 *
 * Strategy:
 *   - Curated contextual topics for the common objective categories (fast, free, exact)
 *   - LLM fallback for novel objectives (rare path)
 *   - Deterministic generic fallback if the LLM is unavailable (never fails)
 */

const { OpenAI } = require('openai');

const MODEL = 'gpt-4o-mini';
const TIMEOUT_MS = 6000;

let _client = null;
function client() {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

/**
 * Curated, contextualized GenAI topics keyed by a coarse objective category.
 * These are the 95% common case — hand-written so they're precise.
 */
const CURATED = {
  founder: {
    name: 'Generative AI for Founders',
    description: 'Use GenAI for market research, customer discovery, MVP prototyping, content, and investor materials at near-zero marginal cost.',
  },
  engineer: {
    name: 'Generative AI for Engineers',
    description: 'AI pair-programming, code review, test generation, and using tools like Copilot/Cursor effectively — including their failure modes.',
  },
  ai_engineer: {
    name: 'Building with LLMs & AI Agents',
    description: 'Go beyond using GenAI — design RAG systems, agentic workflows, evaluations, and production LLM applications.',
  },
  pm: {
    name: 'Generative AI for Product Managers',
    description: 'Use GenAI for user research synthesis, PRD drafting, competitive analysis, and shipping AI-powered features responsibly.',
  },
  data: {
    name: 'Generative AI for Data Work',
    description: 'Accelerate analysis with AI — query generation, exploratory analysis, narrative insights — while keeping rigor and verification.',
  },
  consultant: {
    name: 'Generative AI for Consultants',
    description: 'Research synthesis, deck drafting, framework application, and data analysis — the modern consulting toolkit.',
  },
  marketer: {
    name: 'Generative AI for Marketing',
    description: 'Campaign ideation, ad-copy variants, audience analysis, and creative production at scale.',
  },
  finance: {
    name: 'Generative AI for Finance',
    description: 'Speed up financial modeling, research, and reporting with AI — with the verification discipline finance demands.',
  },
  designer: {
    name: 'Generative AI for Designers',
    description: 'Use AI for ideation, rapid mockups, content, and user research — and know where human craft still wins.',
  },
  exam: {
    name: 'Generative AI for Exam Prep',
    description: 'Use AI to generate practice, get instant explanations, and drill weak areas — with clear guidance on what crosses into dependence.',
  },
  college: {
    name: 'Generative AI for Academics',
    description: 'Use AI to learn faster — concept explanations, revision, practice — while building genuine understanding, not shortcuts.',
  },
  generic: {
    name: 'Generative AI for Your Goal',
    description: 'Use GenAI tools (ChatGPT, Claude, Gemini) to research, learn, and produce faster — a skill that stays relevant across your career.',
  },
};

/**
 * Map an objective to a coarse category for the curated lookup.
 */
function categorize({ objectiveType, specifics = {} }) {
  const role = (specifics.targetRole || '').toLowerCase();
  const skill = (specifics.targetSkill || '').toLowerCase();
  const blob = `${role} ${skill}`.trim();

  if (objectiveType === 'exam_preparation') return 'exam';
  if (objectiveType === 'academic_excellence') return 'college';

  if (/founder|entrepreneur|startup/.test(blob)) return 'founder';
  if (/ai|ml|machine learning|llm|genai|data scien/.test(blob)) {
    return /engineer/.test(blob) ? 'ai_engineer' : 'data';
  }
  if (/sde|software|developer|engineer|devops|backend|frontend|full ?stack/.test(blob)) return 'engineer';
  if (/product manager|\bpm\b|product/.test(blob)) return 'pm';
  if (/data analyst|data engineer|analyst|analytics/.test(blob)) return 'data';
  if (/consult/.test(blob)) return 'consultant';
  if (/market|growth|brand/.test(blob)) return 'marketer';
  if (/finance|investment|banking|cfa/.test(blob)) return 'finance';
  if (/design|ux|ui/.test(blob)) return 'designer';

  if (objectiveType === 'upskilling') {
    if (/ai|ml|llm|genai/.test(skill)) return 'ai_engineer';
    if (/data/.test(skill)) return 'data';
    if (/market|growth/.test(skill)) return 'marketer';
    if (/product/.test(skill)) return 'pm';
    if (/finance/.test(skill)) return 'finance';
    if (/design|ux/.test(skill)) return 'designer';
    if (/founder|entrepreneur/.test(skill)) return 'founder';
  }
  return 'generic';
}

/**
 * LLM fallback — for genuinely novel objectives not covered by the curated map.
 */
async function llmGenAITopic({ objectiveType, specifics }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await client().chat.completions.create({
      model: MODEL,
      temperature: 0.3,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'genai_topic',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
            },
            required: ['name', 'description'],
          },
        },
      },
      messages: [
        {
          role: 'system',
          content: `You write ONE learning topic about how Generative AI specifically complements a given objective. The name must be specific to the objective (not generic "AI literacy"). The description is one sentence on how GenAI helps THIS objective concretely. Do not invent — be practical.`,
        },
        {
          role: 'user',
          content: JSON.stringify({ objectiveType, specifics }),
        },
      ],
    }, { signal: controller.signal });
    clearTimeout(timer);
    const content = resp?.choices?.[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content);
  } catch (err) {
    clearTimeout(timer);
    console.warn('[genaiTopic] LLM fallback failed:', err.message);
    return null;
  }
}

/**
 * Build the contextualized GenAI topic for an objective.
 *
 * @param {Object} args { objectiveType, specifics }
 * @param {Number} sortOrder — where to slot it in the topic list (default: 99, i.e. last)
 * @returns {Object} a topic shaped to match TopicTaxonomy.topicSchema, plus isGenAITopic flag
 */
async function buildGenAITopic({ objectiveType, specifics = {} }, sortOrder = 99) {
  const category = categorize({ objectiveType, specifics });

  let topic = CURATED[category];

  // Only hit the LLM for the truly generic bucket (novel objectives).
  if (category === 'generic') {
    const llm = await llmGenAITopic({ objectiveType, specifics });
    if (llm && llm.name && llm.description) topic = llm;
  }

  // topic is guaranteed (CURATED.generic is the deterministic floor)
  return {
    name: topic.name,
    canonicalName: 'generative-ai-for-objective',
    description: topic.description,
    baseDifficulty: 'intermediate',
    isFutureProofing: true,
    isGenAITopic: true,
    sortOrder,
  };
}

/**
 * Inject the GenAI topic into a topic list if not already present.
 * Idempotent — won't add a second one.
 *
 * @param {Array} topics — the base topic list from TopicTaxonomy
 * @param {Object} objective — { objectiveType, specifics }
 * @returns {Array} topics + the GenAI topic
 */
async function ensureGenAITopic(topics, objective) {
  const list = Array.isArray(topics) ? [...topics] : [];
  if (list.some(t => t && (t.isGenAITopic || t.canonicalName === 'generative-ai-for-objective'))) {
    return list;
  }
  const sortOrder = list.length > 0
    ? Math.max(...list.map(t => t.sortOrder || 0)) + 1
    : 1;
  const genai = await buildGenAITopic(objective, sortOrder);
  list.push(genai);
  return list;
}

module.exports = {
  buildGenAITopic,
  ensureGenAITopic,
  _internal: { categorize, CURATED },
};
