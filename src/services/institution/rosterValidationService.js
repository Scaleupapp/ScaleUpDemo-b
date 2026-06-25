'use strict';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function digits(s) { return String(s || '').replace(/\D/g, ''); }

function validateRoster(rows = [], { seatsAvailable = Infinity } = {}) {
  const errors = [];
  const seenEmail = new Map(), seenPhone = new Map(), seenRoll = new Map();
  const validRows = [];
  rows.forEach((raw, i) => {
    const row = i + 1;
    const name = (raw.name || '').trim();
    const rollNumber = (raw.rollNumber || '').trim();
    const email = (raw.email || '').trim().toLowerCase();
    const phone = (raw.phone || '').trim();
    let rowOk = true;
    if (!name) { errors.push({ row, field: 'name', reason: 'missing name' }); rowOk = false; }
    if (!rollNumber) { errors.push({ row, field: 'rollNumber', reason: 'missing roll number' }); rowOk = false; }
    if (!email) { errors.push({ row, field: 'email', reason: 'missing email' }); rowOk = false; }
    else if (!EMAIL_RE.test(email)) { errors.push({ row, field: 'email', reason: 'malformed email' }); rowOk = false; }
    // Phone is OPTIONAL — email is the identity anchor; students provide their
    // phone at onboarding. Only validate format when a phone is actually given.
    if (phone && digits(phone).length < 8) { errors.push({ row, field: 'phone', reason: 'malformed phone' }); rowOk = false; }
    if (email && seenEmail.has(email)) { errors.push({ row, field: 'email', reason: `duplicate email (row ${seenEmail.get(email)})` }); rowOk = false; }
    if (phone && seenPhone.has(phone)) { errors.push({ row, field: 'phone', reason: `duplicate phone (row ${seenPhone.get(phone)})` }); rowOk = false; }
    if (rollNumber && seenRoll.has(rollNumber)) { errors.push({ row, field: 'rollNumber', reason: `duplicate roll (row ${seenRoll.get(rollNumber)})` }); rowOk = false; }
    if (email) seenEmail.set(email, seenEmail.get(email) || row);
    if (phone) seenPhone.set(phone, seenPhone.get(phone) || row);
    if (rollNumber) seenRoll.set(rollNumber, seenRoll.get(rollNumber) || row);
    if (rowOk) {
      if (validRows.length >= seatsAvailable) { errors.push({ row, field: 'seat', reason: 'seat overflow' }); }
      else validRows.push({ name, rollNumber, email, phone });
    }
  });
  return { validRows, errors, counts: { total: rows.length, valid: validRows.length, invalid: rows.length - validRows.length, duplicates: errors.filter(e => /duplicate/.test(e.reason)).length } };
}
module.exports = { validateRoster };
