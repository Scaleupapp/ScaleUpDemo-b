const test = require('node:test');
const assert = require('node:assert');
const { validateRoster } = require('../../services/institution/rosterValidationService');

test('flags missing fields, bad email, in-file duplicates', () => {
  const rows = [
    { name: 'A', rollNumber: '1', email: 'a@x.edu', phone: '+919800000001' },
    { name: 'B', rollNumber: '2', email: 'bad-email', phone: '+919800000002' },
    { name: '', rollNumber: '3', email: 'c@x.edu', phone: '+919800000003' },
    { name: 'D', rollNumber: '1', email: 'a@x.edu', phone: '+919800000004' }, // dup roll+email
  ];
  const r = validateRoster(rows, { seatsAvailable: 100 });
  assert.strictEqual(r.validRows.length, 1); // only row 1 is clean
  assert.ok(r.errors.find(e => e.row === 2 && e.field === 'email'));
  assert.ok(r.errors.find(e => e.row === 3 && e.field === 'name'));
  assert.ok(r.errors.find(e => e.row === 4 && /duplicate/.test(e.reason)));
});

test('flags seat overflow', () => {
  const rows = [1,2,3].map(i => ({ name: 'N'+i, rollNumber: String(i), email: `n${i}@x.edu`, phone: '+91980000000'+i }));
  const r = validateRoster(rows, { seatsAvailable: 2 });
  assert.ok(r.errors.find(e => e.field === 'seat' && /overflow/.test(e.reason)));
  assert.strictEqual(r.validRows.length, 2);
});
