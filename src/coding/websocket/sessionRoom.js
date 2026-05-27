'use strict';

const { WebSocketServer } = require('ws');
const url = require('url');
const jwt = require('jsonwebtoken');
const CapstoneSession = require('../models/capstoneSession.model');
const orchestrator = require('../services/sandboxOrchestrator');

/**
 * Capstone session WebSocket server (spec §7.3).
 *
 * Four message types, all JSON-encoded:
 *
 *   { type: 'session.pair',      ... }   laptop → server (sent once on connect)
 *   { type: 'session.stats',     ... }   server → mobile (~every 10 sec)
 *   { type: 'session.control',   action: 'pause' | 'resume' | 'abort' | 'submit' }
 *                                          mobile → server
 *   { type: 'session.lifecycle', status: 'provisioning' | ... }
 *                                          server → both (fired on transitions)
 *
 * The room is keyed by sessionId. Each connection joins as either `mobile`
 * or `laptop`. The server doesn't authoritatively know which side is which
 * beyond a query-string hint; the JWT scopes it to a user, but mobile and
 * laptop both authenticate as the same user.
 *
 * No editor mirroring. No screen sharing. Just heartbeat + control.
 */

const HEARTBEAT_INTERVAL_MS = 10_000;

/** sessionId (string) → Set<WebSocket> */
const rooms = new Map();
/** sessionId (string) → heartbeat interval handle */
const heartbeats = new Map();

/**
 * Attach the WS server to an existing HTTP server. Call once from
 * server.js after the HTTP server is created.
 *
 * @param {import('http').Server} httpServer
 */
function attach(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws/coding' });

  wss.on('connection', async (ws, req) => {
    let parsed;
    try {
      parsed = parseQuery(req.url);
    } catch (err) {
      ws.close(1008, 'invalid_query');
      return;
    }
    const { sessionId, token, role } = parsed;

    if (!sessionId || !token) {
      ws.close(1008, 'missing_session_or_token');
      return;
    }

    let userId;
    try {
      const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
      userId = decoded.userId;
    } catch {
      ws.close(1008, 'invalid_token');
      return;
    }

    // Confirm the session exists + belongs to this user. Cheap query; one
    // round-trip per connection, not per message.
    const session = await CapstoneSession.findById(sessionId).select('user_id status').lean();
    if (!session || String(session.user_id) !== String(userId)) {
      ws.close(1008, 'session_not_owned');
      return;
    }

    // Attach metadata; used by broadcast filters + heartbeat.
    ws._sessionId = String(sessionId);
    ws._role = role === 'mobile' ? 'mobile' : 'laptop';

    joinRoom(ws._sessionId, ws);
    sendTo(ws, { type: 'session.lifecycle', status: session.status });

    // Ensure heartbeat is running for this room (idempotent).
    ensureHeartbeat(ws._sessionId);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return; // ignore malformed
      }
      handleClientMessage(ws, msg).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[sessionRoom] handleClientMessage error:', err.message);
      });
    });

    ws.on('close', () => {
      leaveRoom(ws._sessionId, ws);
    });
  });

  return wss;
}

function parseQuery(rawUrl) {
  const u = url.parse(rawUrl, true);
  return {
    sessionId: u.query.sessionId,
    token: u.query.token,
    role: u.query.role,
  };
}

function joinRoom(sessionId, ws) {
  let set = rooms.get(sessionId);
  if (!set) {
    set = new Set();
    rooms.set(sessionId, set);
  }
  set.add(ws);
}

function leaveRoom(sessionId, ws) {
  const set = rooms.get(sessionId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) {
    rooms.delete(sessionId);
    stopHeartbeat(sessionId);
  }
}

function sendTo(ws, payload) {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // ignore — peer probably closed mid-flight
  }
}

/**
 * Broadcast a message to all clients in a session room. If `onlyRole` is
 * provided, only sockets with that role receive it.
 *
 * @param {string} sessionId
 * @param {object} payload
 * @param {'mobile'|'laptop'} [onlyRole]
 */
function broadcast(sessionId, payload, onlyRole) {
  const set = rooms.get(String(sessionId));
  if (!set) return;
  for (const ws of set) {
    if (onlyRole && ws._role !== onlyRole) continue;
    sendTo(ws, payload);
  }
}

/**
 * Heartbeat — publishes `session.stats` to mobile every 10 sec while the
 * session is in_progress. Skips silently if the session moved out of an
 * active state.
 */
function ensureHeartbeat(sessionId) {
  if (heartbeats.has(sessionId)) return;
  const timer = setInterval(async () => {
    try {
      const session = await CapstoneSession.findById(sessionId)
        .select('status counters started_at paused_total_seconds time_budget_seconds')
        .lean();
      if (!session) {
        stopHeartbeat(sessionId);
        return;
      }
      if (session.status !== 'in_progress' && session.status !== 'paused') {
        return;
      }
      const elapsed = computeElapsedSeconds(session);
      const metrics = await orchestrator.getSessionMetrics(sessionId).catch(() => ({
        cpuPct: null,
        memMb: null,
      }));
      broadcast(
        sessionId,
        {
          type: 'session.stats',
          counters: session.counters,
          elapsed_seconds: elapsed,
          time_budget_seconds: session.time_budget_seconds,
          remaining_seconds: Math.max(0, session.time_budget_seconds - elapsed),
          paused_total_seconds: session.paused_total_seconds || 0,
          cpu_pct: metrics.cpuPct,
          mem_mb: metrics.memMb,
        },
        'mobile'
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[sessionRoom] heartbeat error for ${sessionId}:`, err.message);
    }
  }, HEARTBEAT_INTERVAL_MS);
  if (timer.unref) timer.unref();
  heartbeats.set(sessionId, timer);
}

function stopHeartbeat(sessionId) {
  const t = heartbeats.get(sessionId);
  if (t) clearInterval(t);
  heartbeats.delete(sessionId);
}

function computeElapsedSeconds(session) {
  if (!session.started_at) return 0;
  const wall = Math.floor((Date.now() - session.started_at.getTime()) / 1000);
  return Math.max(0, wall - (session.paused_total_seconds || 0));
}

async function handleClientMessage(ws, msg) {
  if (!msg || typeof msg !== 'object') return;

  // Currently only `session.control` is acted on inside the WS layer.
  // Pause/resume could be done via HTTP too — both flows go through the
  // same state machine. Keeping it on the socket lets mobile feel
  // instant.
  if (msg.type === 'session.control') {
    // Lazy require to avoid a circular dep with the controller.
    const capstonesController = require('../controllers/capstones.controller');
    const result = await capstonesController.applyControl({
      sessionId: ws._sessionId,
      userId: undefined, // already authenticated at connection time
      action: msg.action,
    });
    sendTo(ws, { type: 'session.lifecycle', status: result.status });
    broadcast(ws._sessionId, { type: 'session.lifecycle', status: result.status });
  }
}

/**
 * Publish a lifecycle change to a room. Called by controllers + workers
 * whenever a session transitions.
 */
function publishLifecycle(sessionId, status) {
  broadcast(sessionId, { type: 'session.lifecycle', status });
}

module.exports = {
  attach,
  broadcast,
  publishLifecycle,
  // for tests
  _rooms: rooms,
  _heartbeats: heartbeats,
  HEARTBEAT_INTERVAL_MS,
};
