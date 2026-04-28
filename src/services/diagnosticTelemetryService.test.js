const test = require('node:test');
const assert = require('node:assert');

test('logEvent constructs the expected payload', () => {
  let logged = null;
  const tel = require('./diagnosticTelemetryService');
  tel._setEmitter((evt) => { logged = evt; });
  tel.logEvent('diagnostic.started', { userId: 'u1', flowType: 'new_user' });
  assert.strictEqual(logged.event, 'diagnostic.started');
  assert.strictEqual(logged.props.userId, 'u1');
  assert.ok(logged.timestamp);
});

test('logEvent silently no-ops when no emitter set', () => {
  const tel = require('./diagnosticTelemetryService');
  tel._setEmitter(null);
  // should not throw
  tel.logEvent('any.event', {});
  assert.ok(true);
});
