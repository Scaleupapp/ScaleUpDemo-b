'use strict';

/**
 * Central OpenAI model constants (Wave 2 block 7).
 *
 * 'gpt-4o' was hardcoded across ~15 call sites — a model retirement would
 * have silently broken every generation path at once with no single switch
 * to flip. All chat-completion call sites now read this env-backed constant.
 *
 *   OPENAI_CHAT_MODEL      — main generation/chat model (default 'gpt-4o')
 *   OPENAI_CHAT_MODEL_MINI — cost-tier model (default 'gpt-4o-mini')
 *
 * Override via env without a deploy-wide code change.
 *
 * OPENAI_MAX_OUTPUT_TOKENS — gpt-4o's hard output cap is 16,384 tokens.
 * Unlike most OpenAI request params, `max_tokens` above this ceiling doesn't
 * get silently truncated — the API rejects the ENTIRE call with a 400. Any
 * caller that derives max_tokens from a variable count (e.g. "N questions x
 * tokens-per-question") must clamp to this constant or risk a request that
 * always fails once N crosses the threshold, returning zero output instead
 * of a degraded-but-partial result.
 */

const OPENAI_CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-4o';
const OPENAI_CHAT_MODEL_MINI = process.env.OPENAI_CHAT_MODEL_MINI || 'gpt-4o-mini';
const OPENAI_MAX_OUTPUT_TOKENS = parseInt(process.env.OPENAI_MAX_OUTPUT_TOKENS, 10) || 16384;

module.exports = { OPENAI_CHAT_MODEL, OPENAI_CHAT_MODEL_MINI, OPENAI_MAX_OUTPUT_TOKENS };
