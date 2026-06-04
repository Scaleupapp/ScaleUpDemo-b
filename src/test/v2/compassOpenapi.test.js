// src/test/v2/compassOpenapi.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('openapi.yaml declares the CompassCard schema and the five card types', () => {
  const yaml = fs.readFileSync(path.resolve(__dirname, '../../../openapi.yaml'), 'utf8');
  assert.match(yaml, /CompassCard:/);
  for (const t of ['readiness_explanation', 'activity_result', 'topic_detail', 'weak_topics', 'recent_activity']) {
    assert.ok(yaml.includes(t), `openapi.yaml should mention card type ${t}`);
  }
});
