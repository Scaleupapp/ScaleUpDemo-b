const openai = require('../../config/openai');
const { isAllowed } = require('../../config/externalContentWhitelist');

const MODEL = 'gpt-4o-mini';
const TIMEOUT_MS = 12000;
const MAX_LINKS = 3;

const SYSTEM_PROMPT = `You evaluate whether ScaleUp's in-app content is sufficient for a learner to advance one proficiency band on a given topic. If gaps exist, recommend 0-3 free, high-quality external resources from a curated whitelist of domains.

CONSTRAINTS:
- Only recommend resources that are FREE (no paywall, no required signup beyond a free account).
- Only recommend from these domains (or their subdomains): MIT OpenCourseWare (ocw.mit.edu), Harvard CS50 (cs50.harvard.edu), freeCodeCamp, Khan Academy, MDN, web.dev, official docs (react.dev, reactnative.dev, nodejs.org, python.org, mongodb.com/docs, kubernetes.io, AWS docs, GCP docs, MS docs), engineering blogs (Stripe, Cloudflare, Netflix Tech, Meta Engineering, High Scalability), Lenny's Newsletter, Product School, SVPG, arXiv, Distill.pub, Coursera/edX/NPTEL/SWAYAM (free audit only), and curated YouTube channels (3blue1brown, Computerphile, Lex Fridman, Two Minute Papers).
- For Coursera/edX, only suggest the free-audit version.
- For YouTube, ONLY suggest from the listed channels — never random uploads.
- If in-app coverage is sufficient, return { "inAppCoverageAdequate": true, "gaps": [], "externalLinks": [] }.
- Tailor recommendations to the user's measured band (novice/developing/proficient/expert) — don't suggest 'advanced patterns' content for a novice.
- Each link must include url, title, source (the domain or platform name), why (1 sentence explaining why this fills the gap), estimatedMinutes (10-90).`;

const RESPONSE_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'external_content_judgment',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        inAppCoverageAdequate: { type: 'boolean' },
        gaps: { type: 'array', items: { type: 'string' } },
        externalLinks: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              url: { type: 'string' },
              title: { type: 'string' },
              source: { type: 'string' },
              why: { type: 'string' },
              estimatedMinutes: { type: 'integer' },
            },
            required: ['url', 'title', 'source', 'why', 'estimatedMinutes'],
          },
        },
      },
      required: ['inAppCoverageAdequate', 'gaps', 'externalLinks'],
    },
  },
};

const SAFE_DEFAULT = Object.freeze({
  inAppCoverageAdequate: true,
  gaps: [],
  externalLinks: [],
});

async function judgeTopic({ objectiveType, targetKey, topic, measuredBand, inAppContent }) {
  const inAppDescription = (inAppContent || [])
    .map(c => `- ${c.type}: ${c.title}${c.summary ? ` — ${c.summary}` : ''}`)
    .join('\n') || '(none)';

  const userMessage = [
    `Objective type: ${objectiveType}`,
    `Target context: ${targetKey}`,
    `Topic: ${topic}`,
    `Measured band: ${measuredBand}`,
    'In-app content available for this topic:',
    inAppDescription,
    '',
    'Question: is the in-app coverage above sufficient for the user to advance one band on this topic? If not, what specific gaps exist, and what 0-3 external resources from the whitelist would close those gaps?',
  ].join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.3,
      response_format: RESPONSE_SCHEMA,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
    }, { signal: controller.signal });
    clearTimeout(timer);

    const content = resp?.choices?.[0]?.message?.content;
    if (!content) return { ...SAFE_DEFAULT };

    let parsed;
    try { parsed = JSON.parse(content); }
    catch (e) {
      console.warn('[externalContentJudgeService] JSON parse failed:', e.message);
      return { ...SAFE_DEFAULT };
    }

    // Pre-fetch each whitelisted link to verify it's actually readable.
    // Drop links that 404, error, or look like signup-wall pages.
    const allowedRawLinks = (parsed.externalLinks || [])
      .filter(link => link && typeof link.url === 'string' && isAllowed(link.url));

    const validated = [];
    const externalContentFetcherService = require('./externalContentFetcherService');
    for (const link of allowedRawLinks) {
      if (validated.length >= MAX_LINKS) break;
      let snapshot;
      try {
        snapshot = await externalContentFetcherService.fetchSnapshot(link.url);
      } catch {
        continue; // network error — drop
      }
      if (snapshot?.fetchError) continue; // 404, pdf, timeout — drop
      // Signup-wall heuristic: very short excerpts are usually gate pages
      const excerpt = String(snapshot?.excerpt || '');
      const wordCount = Number(snapshot?.wordCount || 0);
      const looksLikeGate = wordCount < 300
        || /sign up|create account|create your account|subscribe to read|log in to continue|register to read/i.test(excerpt);
      if (looksLikeGate) continue;
      validated.push(link);
    }

    const filteredLinks = validated.map(link => ({
      url: link.url,
      title: String(link.title || '').slice(0, 200),
      source: String(link.source || '').slice(0, 80),
      why: String(link.why || '').slice(0, 280),
      estimatedMinutes: Number.isFinite(link.estimatedMinutes) ? Math.max(5, Math.min(180, link.estimatedMinutes)) : 30,
    }));

    return {
      inAppCoverageAdequate: !!parsed.inAppCoverageAdequate,
      gaps: Array.isArray(parsed.gaps) ? parsed.gaps.slice(0, 5) : [],
      externalLinks: filteredLinks,
    };
  } catch (err) {
    clearTimeout(timer);
    console.warn('[externalContentJudgeService] judge failed, returning safe default:', err.message);
    return { ...SAFE_DEFAULT };
  }
}

module.exports = { judgeTopic, _internal: { MAX_LINKS, SAFE_DEFAULT } };
