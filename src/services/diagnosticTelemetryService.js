/**
 * Telemetry — minimal v1. Just emits structured events to a configurable sink.
 * Replace the default emitter with Mixpanel/Posthog/etc. wiring at app startup.
 */

let _emitter = null;

function _setEmitter(fn) { _emitter = fn; }

function logEvent(event, props = {}) {
  if (!_emitter) return;
  try {
    _emitter({ event, props, timestamp: new Date().toISOString() });
  } catch (err) {
    console.warn('[diagnosticTelemetry] emit failed:', err.message);
  }
}

module.exports = { logEvent, _setEmitter };
