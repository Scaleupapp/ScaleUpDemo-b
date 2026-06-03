// src/test/employer/flag.test.js
'use strict';
const assert = require('assert');
process.env.FEATURE_EMPLOYER_MARKETPLACE = 'true';
delete require.cache[require.resolve('../../config/featureFlags')];
const flags = require('../../config/featureFlags');
let pass = 0, fail = 0;
try { assert.strictEqual(flags.employerMarketplace, true); pass++; }
catch (e) { fail++; console.error(e.message); }
console.log(`# tests 1\n# pass ${pass}\n# fail ${fail}`);
process.exit(fail ? 1 : 0);
