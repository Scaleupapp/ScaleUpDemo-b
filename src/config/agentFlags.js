'use strict';

/**
 * Per-agent kill switches for the agentic layer.
 *
 * Default is ON (approved decision 2026-07-12: no shadow mode — the platform
 * pre-launch, agents roll out live and learn from the AgentDecision ledger).
 * Setting AGENT_<ID>_ENABLED=false turns one agent off with zero UX residue,
 * because agents only ever ADD proposals/cards — they never replace flows.
 */
function _envKeyFor(agentId) {
  return `AGENT_${String(agentId).toUpperCase()}_ENABLED`;
}

function isAgentEnabled(agentId) {
  return process.env[_envKeyFor(agentId)] !== 'false';
}

module.exports = { isAgentEnabled, _envKeyFor };
