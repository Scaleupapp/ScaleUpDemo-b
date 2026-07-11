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
 */

const OPENAI_CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-4o';
const OPENAI_CHAT_MODEL_MINI = process.env.OPENAI_CHAT_MODEL_MINI || 'gpt-4o-mini';

module.exports = { OPENAI_CHAT_MODEL, OPENAI_CHAT_MODEL_MINI };
