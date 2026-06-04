// src/services/v2/compassTools.js
'use strict';

/**
 * Compass read-only retrieval tools.
 *
 * Each tool maps to a compassProgressService function. userId is injected by
 * the orchestrator from the authenticated request — the model NEVER supplies it,
 * so a tool can only ever read the calling user's own data. Every tool is
 * read-only and the dispatcher never throws (errors become {ok:false}).
 */

const progress = require('./compassProgressService');

const TOOLS = [
  { name: 'explain_readiness',
    description: "Explain the learner's current readiness score: why it's at that value, which competencies/topics drag it down, and the gap to their target. Use for 'why am I stuck at X%'.",
    input_schema: { type: 'object', properties: {} } },
  { name: 'get_latest_result',
    description: "Get the learner's most recent result for an activity type with its detailed breakdown. Use for 'how did I do on my latest interview / coding assessment / quiz / competition'.",
    input_schema: { type: 'object', properties: { activity_type: { type: 'string', enum: ['quiz', 'interview', 'coding', 'competition', 'content'] } }, required: ['activity_type'] } },
  { name: 'find_activity',
    description: "Find a specific past activity by topic or role and return its breakdown. Use for 'how did I do on the product management quiz' or 'the Google technical interview'.",
    input_schema: { type: 'object', properties: { activity_type: { type: 'string', enum: ['quiz', 'interview', 'coding', 'competition', 'content'] }, query: { type: 'string' } }, required: ['activity_type', 'query'] } },
  { name: 'get_topic_detail',
    description: 'Deep dive on one topic: mastery score, level, trend, history, related misconceptions, and review items. Use when the learner asks about a specific topic.',
    input_schema: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] } },
  { name: 'list_weak_topics',
    description: "List the learner's weakest topics, lowest first. Use for 'what are my weakest topics'.",
    input_schema: { type: 'object', properties: { limit: { type: 'integer' } } } },
  { name: 'list_recent_activity',
    description: "List the learner's recent activity across all types. Use for 'what have I been working on'.",
    input_schema: { type: 'object', properties: { limit: { type: 'integer' }, type: { type: 'string' } } } },
];

async function dispatch({ userId, name, input = {} }) {
  try {
    let data;
    let card = null;
    switch (name) {
      case 'explain_readiness':
        data = await progress.explainReadiness(userId);
        card = data ? { type: 'readiness_explanation', payload: data } : null;
        break;
      case 'get_latest_result':
        data = await progress.getLatestResult(userId, input.activity_type);
        card = data ? { type: 'activity_result', payload: data } : null;
        break;
      case 'find_activity':
        data = await progress.findActivity(userId, input.activity_type, input.query);
        card = data ? { type: 'activity_result', payload: data } : null;
        break;
      case 'get_topic_detail':
        data = await progress.getTopicDetail(userId, input.topic);
        card = data ? { type: 'topic_detail', payload: data } : null;
        break;
      case 'list_weak_topics':
        data = await progress.listWeakTopics(userId, input.limit || 5);
        card = { type: 'weak_topics', payload: { topics: data || [] } };
        break;
      case 'list_recent_activity':
        data = await progress.listRecentActivity(userId, input.limit || 8, input.type || null);
        card = { type: 'recent_activity', payload: { items: data || [] } };
        break;
      default:
        return { ok: false, output: JSON.stringify({ error: `unknown tool ${name}` }), card: null };
    }
    return { ok: true, output: JSON.stringify(data == null ? { result: null } : data), card };
  } catch (err) {
    console.warn('[compassTools] dispatch failed', name, err.message);
    return { ok: false, output: JSON.stringify({ error: 'could not retrieve that right now' }), card: null };
  }
}

module.exports = { TOOLS, dispatch };
