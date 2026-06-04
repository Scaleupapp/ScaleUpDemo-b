// src/test/v2/compassTutoringOpenapi.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
test('openapi.yaml documents the tutoring_result card type and the tutor modes', () => {
  const yaml = fs.readFileSync(path.resolve(__dirname, '../../../openapi.yaml'), 'utf8');
  assert.ok(yaml.includes('tutoring_result'), 'CompassCard enum should include tutoring_result');
  assert.ok(yaml.includes('tutor_topic') && yaml.includes('tutor_result'), 'compass mode enum should include tutor_topic/tutor_result');
});
