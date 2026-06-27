'use strict';
const test = require('node:test'); const assert = require('node:assert');
const outcomeService = require('../../services/institution/outcomeService');
test('buildReportRows returns header + a row per offer', async () => {
  const rows = await outcomeService.buildReportRows({ institutionId: 'i' }, 'c1', {
    PlacementOffer: { find: () => ({ sort: () => ({ lean: async () => ([
      { studentName: 'Aarav', rollNumber: 'CS1', branch: 'CSE', companyName: 'Acme', role: 'SDE', ctc: 30, offerType: 'full_time', status: 'accepted' },
    ]) }) }) },
  });
  assert.ok(Array.isArray(rows.header) && rows.header[0] === 'Student');
  assert.strictEqual(rows.rows.length, 1);
  assert.strictEqual(rows.rows[0][0], 'Aarav');
  assert.strictEqual(rows.rows[0][3], 'Acme');
  assert.strictEqual(rows.rows[0][5], '30');
});
