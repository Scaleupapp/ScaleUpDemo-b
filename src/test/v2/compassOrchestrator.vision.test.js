// src/test/v2/compassOrchestrator.vision.test.js
'use strict';
require('dotenv').config();
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub-for-tests';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ORCH = path.resolve(__dirname, '../../services/v2/compassOrchestrator.js');
const ANTHROPIC = path.resolve(__dirname, '../../config/anthropic.js');
const REDIS = path.resolve(__dirname, '../../config/redis.js');
const CONV = path.resolve(__dirname, '../../models/CompassConversation.js');
// buildUserContext deps (handle() builds context before dispatching) — copy from compassOrchestrator.context.test.js:
const USER = path.resolve(__dirname, '../../models/User.js');
const UO = path.resolve(__dirname, '../../models/UserObjective.js');
const PLAN = path.resolve(__dirname, '../../models/Plan.js');
const KP = path.resolve(__dirname, '../../models/KnowledgeProfile.js');
const USERCTX = path.resolve(__dirname, '../../services/userContextService.js');
const READINESS = path.resolve(__dirname, '../../services/readiness/readinessService.js');
function stub(p, e) { delete require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports: e }; }
function load() { delete require.cache[ORCH]; return require(ORCH); }
function fakeRedis() { const m = new Map(); return { incrby: async (k, n) => { const v = (m.get(k) || 0) + n; m.set(k, v); return v; }, decrby: async () => 0, expire: async () => 1, get: async () => '0' }; }
function ctxStubs() {
  stub(USER, { findById: () => ({ select: () => ({ lean: async () => ({ firstName: 'N' }) }) }) });
  stub(UO, { findOne: () => ({ lean: async () => null }) });
  stub(PLAN, { findOne: () => ({ lean: async () => null }) });
  stub(KP, { findOne: () => ({ lean: async () => null }) });
  stub(USERCTX, { getUserContext: async () => null });
  stub(READINESS, { getServedReadiness: async () => null });
}

test('vision: passes the image to the LLM and returns the reply', async () => {
  stub(REDIS, fakeRedis()); stub(CONV, {}); ctxStubs();
  let captured;
  stub(ANTHROPIC, { messages: { create: async (req) => { captured = req; return { stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'This is a binary tree.' }] }; } } });
  const orch = load();
  const res = await orch.handle({ userId: 'u1', mode: 'vision', payload: { imageBase64: 'IMG', mimeType: 'image/jpeg', message: 'what is this?' } });
  const lastMsg = captured.messages[captured.messages.length - 1];
  assert.equal(lastMsg.content[0].type, 'image');
  assert.equal(lastMsg.content[0].source.data, 'IMG');
  assert.equal(lastMsg.content[1].text, 'what is this?');
  assert.match(res.output.reply, /binary tree/);
});

test('vision: no image → prompts to attach, no LLM call', async () => {
  stub(REDIS, fakeRedis()); stub(CONV, {}); ctxStubs();
  stub(ANTHROPIC, { messages: { create: async () => { throw new Error('should not call LLM'); } } });
  const orch = load();
  const res = await orch.handle({ userId: 'u1', mode: 'vision', payload: { message: 'explain' } });
  assert.match(res.output.reply, /attach a photo/i);
});

test('vision: empty message defaults the prompt to "Explain this."', async () => {
  stub(REDIS, fakeRedis()); stub(CONV, {}); ctxStubs();
  let captured;
  stub(ANTHROPIC, { messages: { create: async (req) => { captured = req; return { stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'ok' }] }; } } });
  const orch = load();
  await orch.handle({ userId: 'u1', mode: 'vision', payload: { imageBase64: 'IMG', mimeType: 'image/jpeg' } });
  assert.equal(captured.messages[captured.messages.length - 1].content[1].text, 'Explain this.');
});
